# SPDX-License-Identifier: Apache-2.0
#
# rqbit - a bittorrent client in Rust, packaged for OpenWrt.
#
# This package installs the upstream prebuilt static musl binary.
# See README.md for why we do not build from source.

include $(TOPDIR)/rules.mk

PKG_NAME:=rqbit
PKG_VERSION:=9.0.1
PKG_RELEASE:=1

PKG_SOURCE:=rqbit-linux-arm64
PKG_SOURCE_URL:=https://github.com/ikatson/rqbit/releases/download/v$(PKG_VERSION)
PKG_HASH:=9ac50a7d1917cd458111265a12346a924b4f7cea7520327782ed5bd6f423b561

PKG_LICENSE:=Apache-2.0
PKG_LICENSE_FILES:=LICENSE
PKG_MAINTAINER:=local

PKG_BUILD_DIR:=$(BUILD_DIR)/$(PKG_NAME)-$(PKG_VERSION)
PKG_BUILD_PARALLEL:=1

# The upstream binary is already linked and stripped of nothing useful;
# let OpenWrt use the target strip explicitly instead of guessing.
STRIP:=$(TARGET_CROSS)strip

include $(INCLUDE_DIR)/package.mk

define Package/rqbit
  SECTION:=net
  CATEGORY:=Network
  SUBMENU:=BitTorrent
  TITLE:=BitTorrent client and server (Rust)
  URL:=https://github.com/ikatson/rqbit
  DEPENDS:=@aarch64 +ca-bundle
  PROVIDES:=rqbit
  CONFLICTS:=rqbit-full
endef

define Package/rqbit/description
  rqbit is a bittorrent client written in Rust. This package ships the
  upstream aarch64-unknown-linux-musl static binary plus a procd service
  wrapper, so it runs on ipq6000 / aarch64_cortex-a53 targets without a
  Rust toolchain in the buildroot.

  Web UI is served by the binary itself at http://<router>:3030/web/
endef

define Package/rqbit/conffiles
/etc/config/rqbit
endef

define Build/Prepare
	mkdir -p $(PKG_BUILD_DIR)
	$(CP) $(DL_DIR)/$(PKG_SOURCE) $(PKG_BUILD_DIR)/rqbit
	chmod 0755 $(PKG_BUILD_DIR)/rqbit
endef

define Build/Compile
	$(TARGET_CROSS)strip --strip-all $(PKG_BUILD_DIR)/rqbit
endef

define Package/rqbit/install
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/rqbit $(1)/usr/bin/rqbit

	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./files/rqbit.init $(1)/etc/init.d/rqbit

	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_CONF) ./files/rqbit.config $(1)/etc/config/rqbit

	$(INSTALL_DIR) $(1)/etc/uci-defaults
	$(INSTALL_BIN) ./files/99-rqbit-defaults $(1)/etc/uci-defaults/99-rqbit-defaults
endef

define Package/rqbit/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	/etc/init.d/rqbit enable
	/etc/init.d/rqbit restart
}
exit 0
endef

define Package/rqbit/prerm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	/etc/init.d/rqbit stop
	/etc/init.d/rqbit disable
}
exit 0
endef

$(eval $(call BuildPackage,rqbit))
