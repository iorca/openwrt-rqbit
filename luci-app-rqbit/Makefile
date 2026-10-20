# SPDX-License-Identifier: Apache-2.0
#
# LuCI web interface for rqbit.

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-rqbit
PKG_VERSION:=9.0.1
PKG_RELEASE:=1

PKG_LICENSE:=Apache-2.0
PKG_MAINTAINER:=local

LUCI_TITLE:=LuCI support for the rqbit torrent client
LUCI_DESCRIPTION:=Web UI to manage the rqbit torrent service: start/stop, add magnets and .torrent files, watch progress and speeds.
LUCI_DEPENDS:=+rqbit +luci-base +luci-compat
LUCI_PKGARCH:=all

# LuCI caches the menu index in /tmp/luci-indexcache*, and rpcd only reads
# acl.d at startup. Without a postinst the menu entry silently stays missing
# until the next reboot.
define Package/$(PKG_NAME)/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	rm -f /tmp/luci-indexcache*
	/etc/init.d/rpcd reload
}
exit 0
endef

define Package/$(PKG_NAME)/prerm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	rm -f /tmp/luci-indexcache*
	/etc/init.d/rpcd reload
}
exit 0
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
$(eval $(call BuildPackage,$(PKG_NAME)))
