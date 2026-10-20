# openwrt-rqbit

[rqbit](https://github.com/ikatson/rqbit) BitTorrent 客户端的 OpenWrt 软件包，含 LuCI Web 界面。

针对 `qualcommax/ipq60xx`（ipq6000，`aarch64_cortex-a53`）开发验证，理论上适用于所有
aarch64 + musl 的目标。

## 包含两个包

| 包 | 架构 | 内容 |
| --- | --- | --- |
| `rqbit` | `aarch64_cortex-a53` | 上游预编译静态二进制 + procd 服务脚本 + UCI 配置 |
| `luci-app-rqbit` | `all` | LuCI 界面（服务状态 / 种子管理 / 设置） |

## 为什么用预编译二进制

rqbit 9.0.1 要求 rustc ≥ 1.97.1，而 OpenWrt `lang/rust` 在 24.10 为 1.94.0、25.12 为
1.96.0，都够不上。所以不从源码编译，直接使用上游 release 的
`aarch64-unknown-linux-musl` 静态二进制 —— 无 `PT_INTERP`、无 `PT_DYNAMIC`，与目标架构匹配。

## 安装

### 从源码树构建

```sh
# 作为 OpenWrt feed
echo "src-git rqbit https://github.com/<你的账号>/openwrt-rqbit" >> feeds.conf.default
./scripts/feeds update rqbit
./scripts/feeds install -a -p rqbit
make menuconfig        # Network -> BitTorrent -> rqbit / luci-app-rqbit
make package/rqbit/compile V=s
```

产物在 `bin/packages/<arch>/base/`。

### 离线打包（不需要 SDK）

```sh
python3 tools/mkipk.py --outdir bin
# 输出 rqbit_9.0.1-1_aarch64_cortex-a53.ipk 和 luci-app-rqbit_9.0.1-1_all.ipk
opkg install /tmp/rqbit_*.ipk /tmp/luci-app-rqbit_*.ipk
```

`tools/mkipk.py` 从各包 Makefile 读取元数据，按 `PKG_SOURCE_URL` 下载、`PKG_HASH` 校验后打包。
仅适用于「预编译二进制」和「纯文件」这两类无需交叉编译的包。

## 架构：为什么浏览器不直接连 rqbit

rqbit 的 CORS 白名单是编译期硬编码的桌面端地址数组
（`crates/librqbit/src/http_api/mod.rs:129-137`），LuCI 页面所在源站不在其中，浏览器
`fetch('http://<router>:3030')` 会被拦。同时 basic auth 凭据只存在于路由器侧。

所以走：浏览器 → ubus → `luci-app-rqbit` 后端（`api.lua`）→ `curl 127.0.0.1:<port>`。

```
www/luci-static/resources/view/rqbit/*.js    界面
root/usr/libexec/rpcd/rqbit                  rpcd exec 插件入口
root/usr/lib/lua/luci/rqbit/api.lua          ubus ↔ rqbit HTTP API 代理
root/usr/share/rpcd/acl.d/*.json             ubus 权限
root/usr/share/luci/menu.d/*.json            菜单
```

rpcd exec 插件约定：`$0 list` 打印方法枚举；`$0 call <method>` 调用，参数对象从 stdin 读入。

## 配置

`/etc/config/rqbit`：

```uci
config rqbit 'main'
	option enabled '1'
	option download_dir '/tmp/rqbit-downloads'
	option http_port '3030'
	option bt_port '4240'
	option listen_addr '0.0.0.0'
	option persistence_dir '/etc/rqbit/state'
	option fastresume '1'
	option disable_dht '0'
	option ratelimit_download_kbs '0'
	option ratelimit_upload_kbs '0'
	option log_level 'warn'
```

完整 Web 界面由二进制自身提供：`http://<路由器>:3030/web/`

### GitHub Actions

三个工作流，全自动，不需要手动干预：

| 工作流 | 触发 | 作用 |
| --- | --- | --- |
| `build-ipk.yml` | push（包目录变更）、手动、每两周 | 用 OpenWrt SDK（qualcommax/ipq60xx）编译两个包，上传 `.ipk` artifact |
| `check-upstream.yml` | 每两周、手动 | 查 `ikatson/rqbit` 最新 release，有新版就改 `PKG_VERSION` / `PKG_HASH` 并打标签，再触发构建 |
| `keepalive.yml` | 每周 | 空提交心跳，防止定时 workflow 被 GitHub 自动禁用 |

几个实现要点：

- **两周节拍**不能用 cron `*/14`。该写法落在「日」字段上，表示每月 1/15/29 号，
  月末会被截断，不是真正的 14 天周期。改用「每周 cron + 纪元周数奇偶闸门」
  （`$(date +%s) / 604800 % 2`），相邻两次运行相差正好 7 天，奇偶必然交替。
- **心跳是必需的**：GitHub 会对「仓库 60 天无活动」的定时 workflow 自动禁用，
  一旦禁用，跟上游的定时检查就永久失效。心跳只在近 5 天无提交时才写，日常开发不会制造噪音。
- **必须显式触发构建**：`check-upstream` 提交用的是 `GITHUB_TOKEN`，而 GitHub 不会为
  `GITHUB_TOKEN` 触发的 push 启动新 workflow run（防递归机制），所以不能依赖 push 级联。
- SDK 版本自动探测 25.12.x 最新版，需要固定时改 `env.RELEASE_PIN`。
- 编译依赖里**不要**装 `python3-distutils`，Ubuntu 24.04 (noble) 已移除该包。

## 已知限制

- 未挂 USB 存储时下载目录只能放 `/tmp`（tmpfs，重启清空）。挂上存储后把
  `download_dir` 指到 `/mnt/...`。
- 路由器 NAND overlay 空间紧张时，务必设置 `persistence_dir`，否则 rqbit 会把会话状态
  写进 `$HOME/.cache`（实测会吃掉数 MB）。
- `luci-app-rqbit` 的 UCI schema 跟随 opkg 版 `rqbit` 包（`/etc/config/rqbit`），
  不是本仓库 `rqbit/` 包自带的 `files/rqbit.config`。两者字段不同，若混用需自行对齐。

## 许可

Apache-2.0，见 [LICENSE](LICENSE)。
