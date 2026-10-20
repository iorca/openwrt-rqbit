-- SPDX-License-Identifier: Apache-2.0
--
-- rpcd backend for luci-app-rqbit.
--
-- Why a backend instead of letting the browser call rqbit directly:
--   * rqbit's CORS allowlist is a hardcoded array of dev origins
--     (crates/librqbit/src/http_api/mod.rs:129-137), so a LuCI page on
--     192.168.5.1 cannot fetch http://192.168.5.1:3030 from the browser.
--   * basic auth, when enabled, lives in an env var on the router side.
-- So: browser -> ubus -> this file -> curl 127.0.0.1:<port>.
--
-- Response shapes below are transcribed from the source, not guessed:
--   crates/librqbit/src/api.rs:521        TorrentListResponse  { torrents: [..] }
--   crates/librqbit/src/api.rs:538        TorrentDetailsResponse
--   crates/librqbit/src/api.rs:555        ApiAddTorrentResponse
--   crates/librqbit/src/torrent_state/stats.rs:72   TorrentStats
--   crates/librqbit/src/torrent_state/stats.rs:224  Speed { mbps }
--   crates/librqbit/src/torrent_state/stats.rs:205  time_remaining { duration, human_readable }
--   crates/librqbit/src/session_stats/snapshot.rs:12 SessionStatsSnapshot
--
-- Note /torrents defaults to with_stats=false (api.rs:173, api.rs:232), so the
-- list endpoint MUST be called with ?with_stats=true to get progress.

local fs = require "nixio.fs"
local jsonc = require "luci.jsonc"
local uci = require "luci.model.uci".cursor()

-- UCI schema here matches the opkg "rqbit" package on this device
-- (/etc/config/rqbit: http_port, listen_addr, basic_auth, ...), NOT my own
-- package's schema. The binary and init script stay upstream; this app is
-- only the UI layer.
local function api_origin()
	local port = uci:get("rqbit", "main", "http_port") or "3030"
	local addr = uci:get("rqbit", "main", "listen_addr") or "0.0.0.0"
	if addr == "0.0.0.0" or addr == "::" or addr == "" then
		addr = "127.0.0.1"
	end
	return "http://" .. addr .. ":" .. port, port
end

local function api_port()
	local _, port = api_origin()
	return port
end

local function shq(s)
	return "'" .. tostring(s):gsub("'", "'\\''") .. "'"
end

local function fail(msg)
	return { ok = false, error = tostring(msg) }
end

-- Run curl against the local rqbit. Returns body string, http code.
local function http(method, path, body, ctype)
	local origin = api_origin()
	local url = origin .. path
	-- Every value that can contain whitespace or shell metacharacters MUST go
	-- through shq(). io.popen() runs this through /bin/sh, so an unquoted
	-- "Content-Type: application/octet-stream" word-splits into two argv
	-- entries: "-H Content-Type:" plus a bogus second URL, which makes curl
	-- bail out with http_code 000.
	local argv = {
		"curl", "-sS", "-m", "180",
		"-o", shq("/tmp/.rqbit-resp"),
		"-w", shq("%{http_code}"),
		"-X", shq(method),
	}

	if ctype then
		argv[#argv + 1] = "-H"
		argv[#argv + 1] = shq("Content-Type: " .. ctype)
	end

	local auth = uci:get("rqbit", "main", "basic_auth")
	if auth and auth ~= "" then
		argv[#argv + 1] = "-u"
		argv[#argv + 1] = shq(auth)
	end

	local stdin_file
	if body and #body > 0 then
		stdin_file = "/tmp/.rqbit-req"
		if not fs.writefile(stdin_file, body) then
			return "", 0, "cannot write request body"
		end
		argv[#argv + 1] = "--data-binary"
		argv[#argv + 1] = shq("@" .. stdin_file)
	end

	argv[#argv + 1] = shq(url)

	local cmd = table.concat(argv, " ") .. " 2>/dev/null"
	local p = io.popen(cmd)
	local code = tonumber(p:read("*a") or "0") or 0
	p:close()

	if stdin_file then fs.unlink(stdin_file) end

	local resp = fs.readfile("/tmp/.rqbit-resp") or ""
	fs.unlink("/tmp/.rqbit-resp")
	return resp, code
end

local function call(method, path, body, ctype)
	local resp, code = http(method, path, body, ctype)
	if code == 0 then
		return nil, 0, "rqbit API not reachable on 127.0.0.1:" .. api_port() .. " - is the service running?"
	end
	local obj = jsonc.parse(resp)
	if not obj then
		return nil, code, resp
	end
	return obj, code, resp
end

-- ---------------------------------------------------------------- read ----

local function status()
	local stats, code = call("GET", "/stats")
	if not stats then
		return {
			ok = false,
			error = "rqbit API unreachable on 127.0.0.1:" .. api_port(),
			running = false,
		}
	end

	-- with_stats=true is required, see api.rs:232.
	local list = call("GET", "/torrents?with_stats=true")

	local p = io.popen("/etc/init.d/rqbit running >/dev/null 2>&1; echo $?")
	local rc = p:read("*l")
	p:close()

	-- The opkg init script registers START=99 -> /etc/rc.d/S99rqbit.
	local enabled = false
	local pp = io.popen("ls /etc/rc.d/S*rqbit >/dev/null 2>&1; echo $?")
	enabled = pp:read("*l") == "0"
	pp:close()

	return {
		ok = true,
		running = rc == "0",
		enabled = enabled,
		api_port = api_port(),
		webui = "http://" .. (uci:get("rqbit", "main", "listen_addr") or "")
			.. ":" .. api_port() .. "/web/",
		download_dir = uci:get("rqbit", "main", "download_dir"),
		stats = stats,
		torrents = (list and list.torrents) or {},
	}
end

local function torrent_files(req)
	local id = req.id
	if not id then return fail("id required") end
	local obj, code, raw = call("GET", "/torrents/" .. id)
	if not obj then
		return fail("HTTP " .. tostring(code) .. ": " .. tostring(raw))
	end
	return { ok = true, details = obj }
end

-- --------------------------------------------------------------- write ----

local function add(req)
	local body = req.body
	if not body or body == "" then
		return fail("empty body: paste a magnet link, a .torrent URL, or upload a file")
	end

	-- A .torrent uploaded from the browser arrives base64-encoded, because ubus
	-- arguments are JSON strings and raw bencode is not valid UTF-8. Decode it
	-- back to bytes before handing it to rqbit.
	local b64 = body:match("^__B64__(.*)$")
	if b64 then
		local tmp = "/tmp/.rqbit-torrent"
		local p = io.popen("printf %s " .. shq(b64) .. " | base64 -d > " .. tmp .. " 2>/dev/null; echo $?")
		local rc = p:read("*l")
		p:close()
		if rc ~= "0" then
			fs.unlink(tmp)
			return fail("cannot decode uploaded .torrent (base64)")
		end
		body = fs.readfile(tmp) or ""
		fs.unlink(tmp)
		if body == "" then
			return fail("uploaded .torrent decoded to zero bytes")
		end
		req.is_url = false
	end

	local q = {}
	if req.paused then q[#q + 1] = "paused=true" end
	if req.overwrite then q[#q + 1] = "overwrite=true" end
	if req.list_only then q[#q + 1] = "list_only=true" end
	if req.is_url then q[#q + 1] = "is_url=true" end
	if req.output_folder and req.output_folder ~= "" then
		q[#q + 1] = "output_folder=" .. require("luci.util").urlencode(req.output_folder)
	end
	if req.only_files_regex and req.only_files_regex ~= "" then
		q[#q + 1] = "only_files_regex=" .. require("luci.util").urlencode(req.only_files_regex)
	end

	local path = "/torrents"
	if #q > 0 then path = path .. "?" .. table.concat(q, "&") end

	local obj, code, raw = call("POST", path, body, "application/octet-stream")
	if not obj then
		return fail(string.format("add failed (HTTP %s): %s", tostring(code), tostring(raw)))
	end
	-- ApiAddTorrentResponse { id, details, output_folder, seen_peers }
	return { ok = true, id = obj.id, details = obj.details }
end

local function action(req)
	local id, act = req.id, req.action
	if not id or not act then return fail("id and action required") end

	local allowed = {
		pause = true, start = true, forget = true, delete = true,
	}
	if not allowed[act] then
		return fail("unsupported action: " .. tostring(act))
	end

	local obj, code, raw = call("POST", "/torrents/" .. id .. "/" .. act)
	if code < 200 or code >= 300 then
		return fail(string.format("%s failed (HTTP %s): %s", act, tostring(code), tostring(raw)))
	end
	return { ok = true }
end

local function only_files(req)
	local id = req.id
	if not id then return fail("id required") end
	local body = jsonc.stringify({ only_files = req.files or {} })
	local obj, code, raw = call("POST", "/torrents/" .. id .. "/update_only_files", body, "application/json")
	if code < 200 or code >= 300 then
		return fail("update_only_files failed (HTTP " .. tostring(code) .. "): " .. tostring(raw))
	end
	return { ok = true }
end

local function restart()
	local p = io.popen("/etc/init.d/rqbit restart >/dev/null 2>&1; echo $?")
	local rc = p:read("*l")
	p:close()
	return { ok = rc == "0", rc = tonumber(rc) }
end

-- ----------------------------------------------------------------- rpc ----

local methods = {
	status = status,
	torrent_files = torrent_files,
	add = add,
	action = action,
	only_files = only_files,
	restart = restart,
}

local function dispatch(req)
	local fn = req and req.method and methods[req.method]
	if not fn then
		return fail("unknown method: " .. tostring(req and req.method))
	end
	local ok, res = pcall(fn, req)
	if not ok then
		return fail(res)
	end
	return res
end

return { dispatch = dispatch }
