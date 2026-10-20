'use strict';
'require view';
'require rpc';
'require ui';
'require poll';

/*
 * luci-app-rqbit - rqbit torrent client for OpenWrt / LuCI 27.x
 *
 * Every data call goes through ubus -> /usr/lib/lua/luci/rqbit/api.lua -> curl
 * 127.0.0.1:<port>. The browser cannot talk to rqbit directly because rqbit's
 * CORS allowlist is a hardcoded array (http_api/mod.rs:129-137).
 *
 * Field names used below come from the rqbit source:
 *   TorrentDetailsResponse { id, info_hash, name, output_folder, total_pieces, files, stats }
 *   TorrentStats  { state, error, progress_bytes, uploaded_bytes, total_bytes, finished, live }
 *   live.download_speed.mbps / live.upload_speed.mbps
 *   live.time_remaining.human_readable
 */

var callStatus = rpc.declare({
	object: 'rqbit',
	method: 'status',
	expect: { }
});

var callAdd = rpc.declare({
	object: 'rqbit',
	method: 'add',
	params: [ 'body', 'is_url', 'paused', 'output_folder', 'only_files_regex' ],
	expect: { }
});

var callAction = rpc.declare({
	object: 'rqbit',
	method: 'action',
	params: [ 'id', 'action' ],
	expect: { }
});

var callRestart = rpc.declare({
	object: 'rqbit',
	method: 'restart',
	expect: { }
});

var callTorrentFiles = rpc.declare({
	object: 'rqbit',
	method: 'torrent_files',
	params: [ 'id' ],
	expect: { }
});

function fmtBytes(n) {
	n = +n || 0;
	if (n <= 0) return '0 B';
	var u = [ 'B', 'KiB', 'MiB', 'GiB', 'TiB' ];
	var i = Math.floor(Math.log(n) / Math.log(1024));
	i = Math.min(i, u.length - 1);
	return (n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 2) + ' ' + u[i];
}

function fmtSpeed(mbps) {
	mbps = +mbps || 0;
	return (mbps).toFixed(2) + ' MiB/s';
}

function fmtPct(prog, total) {
	prog = +prog || 0; total = +total || 0;
	if (total <= 0) return '0%';
	return (prog / total * 100).toFixed(1) + '%';
}

/* state 枚举（stats.rs:48-58，serde 小写）：
 * initializing | live | paused | error。做种判断用 finished（stats.rs:83）。 */
function stateLabel(st, finished) {
	switch (st) {
	case 'live': return finished ? _('做种中') : _('下载中');
	case 'paused': return _('已暂停');
	case 'initializing': return _('校验中');
	case 'error': return _('错误');
	default: return st || _('未知');
	}
}

function stateClass(st, finished) {
	switch (st) {
	case 'live': return finished ? 'label label-info' : 'label label-success';
	case 'paused': return 'label label-warning';
	case 'initializing': return 'label label-info';
	case 'error': return 'label label-danger';
	default: return 'label';
	}
}

	return view.extend({
	load: function() {
		return L.resolveDefault(callStatus(), {});
	},

	handleAdd: function(ev) {
		var input = document.querySelector('#rqbit-magnet');
		var body = (input.value || '').trim();
		if (!body) {
			ui.addNotification(null, E('p', _('请先粘贴磁力链接或种子 URL。')), 'warning');
			return;
		}

		var isUrl = /^(magnet:|https?:\/\/|file:\/\/)/i.test(body);
		var paused = document.querySelector('#rqbit-paused').checked;
		var folder = (document.querySelector('#rqbit-folder').value || '').trim();

		ui.showModal(_('正在添加种子'), [
			E('p', { 'class': 'spinning' }, _('正在联系 Tracker，请稍候...'))
		]);

		return callAdd(body, isUrl, paused, folder || null, null).then(function(res) {
			ui.hideModal();
			if (!res || res.ok === false) {
				ui.addNotification(null, E('p', [ _('添加失败：'), (res && res.error) || _('未知错误') ]), 'error');
				return;
			}
			input.value = '';
			ui.addNotification(null, E('p', _('种子已添加。')), 'info');
			return this.refresh();
		}.bind(this)).catch(function(e) {
			ui.hideModal();
			ui.addNotification(null, E('p', _('添加失败：') + e.message), 'error');
		});
	},

	handleUpload: function(ev) {
		var input = document.querySelector('#rqbit-file');
		if (!input.files || !input.files.length) return;

		var file = input.files[0];
		var reader = new FileReader();

		ui.showModal(_('正在上传种子文件'), [
			E('p', { 'class': 'spinning' }, _('正在读取文件...'))
		]);

		reader.onload = function() {
			/* rpcd ubus arguments are JSON strings, so ship the torrent as
			 * base64 and decode it in the backend. */
			var b64 = btoa(new Uint8Array(reader.result)
				.reduce(function(s, b) { return s + String.fromCharCode(b); }, ''));

			return callAdd('__B64__' + b64, false, false, null, null).then(function(res) {
				ui.hideModal();
				if (!res || res.ok === false) {
					ui.addNotification(null, E('p', [ _('上传失败：'), (res && res.error) || _('未知') ]), 'error');
					return;
				}
				ui.addNotification(null, E('p', _('种子已添加。')), 'info');
				input.value = '';
				return this.refresh();
			}.bind(this)).catch(function(e) {
				ui.hideModal();
				ui.addNotification(null, E('p', _('上传失败：') + e.message), 'error');
			});
		}.bind(this);

		reader.readAsArrayBuffer(file);
	},

	handleAction: function(id, action, name) {
		var msg = {
			pause: _('暂停“%s”？').format(name),
			start: _('恢复“%s”？').format(name),
			forget: _('从列表中移除“%s”并保留文件？').format(name),
			delete: _('删除“%s”及其磁盘文件？此操作不可撤销。').format(name)
		}[action];

		if (action === 'delete' && !confirm(msg)) return Promise.resolve();
		if (action !== 'delete' && (action === 'forget' || action === 'pause' || action === 'start')) {
			if (action === 'forget' && !confirm(msg)) return Promise.resolve();
		}

		return callAction(id, action).then(function(res) {
			if (!res || res.ok === false)
				ui.addNotification(null, E('p', (res && res.error) || _('操作失败')), 'error');
			return this.refresh();
		}.bind(this));
	},

	renderTorrents: function(torrents) {
		if (!torrents || !torrents.length)
			return E('p', { 'class': 'cbi-section-descr' }, _('暂无种子，请在上方添加。'));

		var rows = torrents.map(function(t) {
			var s = t.stats || {};
			var live = s.live || {};
			var pct = fmtPct(s.progress_bytes, s.total_bytes);
			var st = s.state || 'unknown';
			var fin = !!s.finished;
			var numPct = s.total_bytes > 0 ? (s.progress_bytes / s.total_bytes * 100) : 0;

			return E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td', 'data-title': _('名称') }, [
					E('strong', {}, t.name || t.info_hash.substring(0, 16)),
					E('br'),
					E('small', { 'class': 'cbi-section-descr' },
						(t.output_folder || '') + ' · ' + (t.info_hash || '').substring(0, 16) + '…')
				]),
				E('td', { 'class': 'td', 'data-title': _('状态') }, [
					E('span', { 'class': stateClass(st, fin) }, stateLabel(st, fin)),
					s.error ? E('div', { 'class': 'cbi-section-descr' }, s.error) : ''
				]),
				E('td', { 'class': 'td', 'data-title': _('进度') }, [
					E('div', {
						'style': 'background:rgba(0,0,0,.12);border-radius:3px;height:14px;position:relative;min-width:120px;overflow:hidden'
					}, [
						E('div', {
							'style': 'width:%s%%;height:100%%;background:%s'.format(
								numPct.toFixed(1),
								st === 'error' ? '#d9534f' : (s.finished ? '#5cb85c' : '#337ab7'))
						})
					]),
					E('small', {}, pct + ' · ' + fmtBytes(s.progress_bytes) + ' / ' + fmtBytes(s.total_bytes))
				]),
				E('td', { 'class': 'td', 'data-title': _('速度') }, [
					E('div', {}, [ '↓ ', fmtSpeed(live.download_speed && live.download_speed.mbps) ]),
					E('div', {}, [ '↑ ', fmtSpeed(live.upload_speed && live.upload_speed.mbps) ]),
					live.time_remaining
						? E('small', { 'class': 'cbi-section-descr' }, _('剩余 ') + live.time_remaining.human_readable)
						: ''
				]),
				E('td', { 'class': 'td', 'data-title': _('操作') }, [
					st === 'paused'
						? E('button', {
							'class': 'cbi-button cbi-button-apply',
							'click': ui.createHandlerFn(this, 'handleAction', t.id, 'start', t.name || t.info_hash)
						}, _('恢复'))
						: E('button', {
							'class': 'cbi-button',
							'click': ui.createHandlerFn(this, 'handleAction', t.id, 'pause', t.name || t.info_hash)
						}, _('暂停')),
					' ',
					E('button', {
						'class': 'cbi-button',
						'click': ui.createHandlerFn(this, 'handleAction', t.id, 'forget', t.name || t.info_hash)
					}, _('移除')),
					' ',
					E('button', {
						'class': 'cbi-button cbi-button-remove',
						'click': ui.createHandlerFn(this, 'handleAction', t.id, 'delete', t.name || t.info_hash)
					}, _('删除'))
				])
			]);
		}.bind(this));

		return E('div', { 'class': 'table' }, [
			E('table', { 'class': 'table' }, [
				E('tr', { 'class': 'tr table-titles' }, [
					E('th', { 'class': 'th' }, _('名称')),
					E('th', { 'class': 'th' }, _('状态')),
					E('th', { 'class': 'th' }, _('进度')),
					E('th', { 'class': 'th' }, _('速度')),
					E('th', { 'class': 'th' }, _('操作'))
				])
			].concat(rows))
		]);
	},

	renderStats: function(st) {
		var s = st.stats || {};
		var peers = s.peers || {};

		function cell(title, value) {
			return E('div', { 'class': 'ifacebox', 'style': 'flex:1 1 150px;margin:4px' }, [
				E('div', { 'class': 'ifacebox-head' }, title),
				E('div', { 'class': 'ifacebox-body', 'style': 'font-size:150%;text-align:center' }, value)
			]);
		}

		return E('div', { 'style': 'display:flex;flex-wrap:wrap' }, [
			cell(_('下载'), fmtSpeed(s.download_speed && s.download_speed.mbps)),
			cell(_('上传'), fmtSpeed(s.upload_speed && s.upload_speed.mbps)),
			cell(_('节点'), String(peers.live || 0)),
			cell(_('已下载'), fmtBytes(s.counters && s.counters.fetched_bytes)),
			cell(_('已上传'), fmtBytes(s.counters && s.counters.uploaded_bytes)),
			cell(_('运行时间'), Math.floor((s.uptime_seconds || 0) / 60) + ' min')
		]);
	},

	/* 顶部状态横幅。放在独立容器里由 refresh() 整体重建，否则服务在两次
	 * 轮询之间恢复/掉线时，横幅会一直停在加载那一刻的状态。 */
	renderBanner: function(st) {
		if (!st || !st.ok) {
			return E('div', { 'class': 'alert-message warning' }, [
				E('strong', {}, _('rqbit 服务未连接。')),
				(st && st.error) || '',
				' ',
				E('button', {
					'class': 'cbi-button cbi-button-action',
					'click': ui.createHandlerFn(this, 'handleRestart')
				}, _('启动/重启服务'))
			]);
		}
		var port = st.api_port || '3030';
		return E('div', { 'class': 'cbi-section-descr' }, [
			_('服务运行中 · API 端口 %s · ').format(port),
			E('a', { 'href': 'http://%s:%s/web/'.format(window.location.hostname, port), 'target': '_blank' },
				_('打开 rqbit 完整 Web 界面'))
		]);
	},

	/* 流量区常驻（服务掉线时显示占位文案），refresh() 负责双向刷新。 */
	renderStatsBox: function(st) {
		return E('div', { 'class': 'cbi-section', 'id': 'rqbit-stats' }, [
			E('h3', {}, _('流量')),
			(st && st.ok)
				? this.renderStats(st)
				: E('p', { 'class': 'cbi-section-descr' }, _('服务未运行，无法读取流量。'))
		]);
	},

	render: function(data) {
		var st = data[0] || {};

		/* 每 5 秒轮询刷新横幅、流量与种子列表。 */
		poll.add(L.bind(this.refresh, this), 5);

		return E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('rqbit')),
			E('div', { 'class': 'cbi-map-descr' },
				_('BitTorrent 下载服务。本页用于管理服务与种子。')),

			E('div', { 'id': 'rqbit-banner' }, [ this.renderBanner(st) ]),

			this.renderStatsBox(st),

			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, _('添加种子')),
				E('div', { 'class': 'cbi-value' }, [
					E('label', { 'class': 'cbi-value-title', 'for': 'rqbit-magnet' }, _('磁力链接或 URL')),
					E('div', { 'class': 'cbi-value-field' }, [
						E('input', {
							'id': 'rqbit-magnet',
							'class': 'cbi-input-text',
							'style': 'width:100%',
							'placeholder': 'magnet:?xt=urn:btih:… 或 https://example.com/file.torrent'
						})
					])
				]),
				E('div', { 'class': 'cbi-value' }, [
					E('label', { 'class': 'cbi-value-title', 'for': 'rqbit-file' }, _('.torrent 文件')),
					E('div', { 'class': 'cbi-value-field' }, [
						E('input', { 'id': 'rqbit-file', 'type': 'file', 'accept': '.torrent' }),
						E('button', {
							'class': 'cbi-button cbi-button-action',
							'click': ui.createHandlerFn(this, 'handleUpload')
						}, _('上传'))
					])
				]),
				E('div', { 'class': 'cbi-value' }, [
					E('label', { 'class': 'cbi-value-title', 'for': 'rqbit-folder' }, _('保存目录')),
					E('div', { 'class': 'cbi-value-field' }, [
						E('input', {
							'id': 'rqbit-folder',
							'class': 'cbi-input-text',
							'placeholder': st.download_dir || '/tmp/rqbit-downloads'
						}),
						E('div', { 'class': 'cbi-value-description' },
							_('留空则使用已配置的下载目录。'))
					])
				]),
				E('div', { 'class': 'cbi-value' }, [
					E('label', { 'class': 'cbi-value-title' }, _('选项')),
					E('div', { 'class': 'cbi-value-field' }, [
						E('label', {}, [
							E('input', { 'id': 'rqbit-paused', 'type': 'checkbox' }),
							' ', _('添加后保持暂停')
						])
					])
				]),
				E('div', { 'class': 'cbi-page-actions' }, [
					E('button', {
						'class': 'cbi-button cbi-button-apply',
						'click': ui.createHandlerFn(this, 'handleAdd')
					}, _('添加种子')),
					' ',
					E('button', {
						'class': 'cbi-button',
						'click': ui.createHandlerFn(this, 'handleRestart')
					}, _('重启服务'))
				])
			]),

			E('div', { 'class': 'cbi-section', 'id': 'rqbit-list' }, [
				E('h3', {}, _('种子列表')),
				this.renderTorrents(st.torrents)
			])
		]);
	},

	handleRestart: function() {
		ui.showModal(_('正在重启'), [
			E('p', { 'class': 'spinning' }, _('等待服务重新上线...'))
		]);
		return callRestart().then(function() {
			return new Promise(function(r) { setTimeout(r, 2500); });
		}).then(function() {
			ui.hideModal();
			return location.reload();
		});
	},

	refresh: function() {
		return callStatus().then(function(st) {
			st = st || {};

			/* 横幅：服务上线/掉线两个方向都要能翻转。 */
			var banner = document.querySelector('#rqbit-banner');
			if (banner) {
				banner.innerHTML = '';
				banner.appendChild(this.renderBanner(st));
			}

			/* 流量区。 */
			var statsBox = document.querySelector('#rqbit-stats');
			if (statsBox) {
				var sHead = statsBox.querySelector('h3');
				statsBox.innerHTML = '';
				if (sHead) statsBox.appendChild(sHead);
				statsBox.appendChild(st.ok
					? this.renderStats(st)
					: E('p', { 'class': 'cbi-section-descr' }, _('服务未运行，无法读取流量。')));
			}

			/* 服务不可用时没有列表可刷，保留原样。 */
			if (!st.ok) return;

			var box = document.querySelector('#rqbit-list');
			if (!box) return;
			var head = box.querySelector('h3');
			box.innerHTML = '';
			if (head) box.appendChild(head);
			box.appendChild(this.renderTorrents(st.torrents));
		}.bind(this));
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
