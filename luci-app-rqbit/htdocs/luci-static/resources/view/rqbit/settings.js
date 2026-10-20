'use strict';
'require view';
'require form';
'require rpc';

/*
 * 设置页。直接绑定设备上 opkg "rqbit" 包的 UCI schema：
 *   /etc/config/rqbit -> config rqbit 'main'
 * 字段清单来自该包的 init 脚本（/etc/init.d/rqbit）。
 */

var callRestart = rpc.declare({
	object: 'rqbit',
	method: 'restart',
	expect: { ok: true }
});

return view.extend({
	render: function() {
		var m, s, o;

		m = new form.Map('rqbit', _('rqbit - 设置'),
			_('BitTorrent 服务配置。点击"保存并应用"后会自动重启服务使配置生效。'));

		s = m.section(form.NamedSection, 'main', 'rqbit', _('常规'));
		s.addremove = false;

		o = s.option(form.Flag, 'enabled', _('启用服务'));
		o.default = '0';
		o.rmempty = false;

		o = s.option(form.Value, 'download_dir', _('下载目录'),
			_('下载文件的保存位置。路由器未挂载 USB 存储时请使用 /tmp 下的路径（重启后清空）。'));
		o.default = '/tmp/rqbit-downloads';
		o.rmempty = false;
		o.datatype = 'string';

		o = s.option(form.Value, 'persistence_dir', _('会话状态目录'),
			_('保存种子会话状态，重启后可据此恢复任务。'));
		o.default = '/etc/rqbit/state';
		o.placeholder = '/etc/rqbit/state';

		o = s.option(form.Flag, 'fastresume', _('快速恢复'),
			_('启动时尽可能跳过完整的文件校验。'));

		o = s.option(form.Flag, 'disable_dht', _('禁用 DHT'));

		s = m.section(form.NamedSection, 'main', 'rqbit', _('网络'));
		s.addremove = false;

		o = s.option(form.Value, 'listen_addr', _('API 监听地址'));
		o.default = '0.0.0.0';
		o.datatype = 'ipaddr';
		o.rmempty = false;

		o = s.option(form.Value, 'http_port', _('API / Web 界面端口'));
		o.default = '3030';
		o.datatype = 'port';
		o.rmempty = false;

		o = s.option(form.Value, 'bt_port', _('BitTorrent 连接端口'));
		o.default = '4240';
		o.datatype = 'port';

		o = s.option(form.Value, 'basic_auth', _('HTTP 基本认证'),
			_('格式：用户名:密码。留空则不启用。API 与内置 Web 界面共用此认证。'));
		o.password = true;

		o = s.option(form.Value, 'socks_url', _('SOCKS5 代理'),
			_('socks5://[用户名:密码@]主机:端口 - 所有对外连接都会走此代理。'));

		s = m.section(form.NamedSection, 'main', 'rqbit', _('性能'));
		s.addremove = false;

		o = s.option(form.Value, 'ratelimit_download_kbs', _('下载限速 (KiB/s)'));
		o.datatype = 'uinteger';
		o.placeholder = '0 = 不限速';

		o = s.option(form.Value, 'ratelimit_upload_kbs', _('上传限速 (KiB/s)'));
		o.datatype = 'uinteger';
		o.placeholder = '0 = 不限速';

		o = s.option(form.Value, 'worker_threads', _('工作线程数'));
		o.datatype = 'uinteger';
		o.placeholder = '0 = 自动';

		o = s.option(form.ListValue, 'log_level', _('日志级别'));
		o.value('error', 'error');
		o.value('warn', 'warn');
		o.value('info', 'info');
		o.value('debug', 'debug');
		o.value('trace', 'trace');
		o.default = 'warn';

		return m.render();
	},

	handleSaveApply: function(ev, mode) {
		return this.handleSave(ev).then(function() {
			return callRestart();
		}).then(function() {
			return new Promise(function(r) { setTimeout(r, 2000); });
		});
	}
});
