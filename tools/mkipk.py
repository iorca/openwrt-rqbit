#!/usr/bin/env python3
"""Build opkg (.ipk) packages for openwrt-rqbit without a full OpenWrt SDK.

An .ipk is a Unix "ar" archive holding exactly three members:

    debian-binary     the ASCII string "2.0\\n"
    control.tar.gz    ./control, ./conffiles, ./postinst, ./prerm
    data.tar.gz       the payload, rooted at "/"

Package metadata is read straight out of each package Makefile, so the
version / depends / conffiles there stay the single source of truth. The
upstream tarball or binary is downloaded from PKG_SOURCE_URL and verified
against PKG_HASH before being packaged.

This is an offline shortcut for two packages whose payload is either a
prebuilt static binary or plain arch-independent files -- i.e. there is no
compilation step the SDK would otherwise provide. For anything that needs a
real cross toolchain, use the SDK (see .github/workflows/build-ipk.yml).

Usage:
    python3 tools/mkipk.py [--outdir bin] [--binary /path/to/rqbit-linux-arm64]
"""

import argparse
import gzip
import hashlib
import io
import os
import re
import shutil
import sys
import tarfile
import tempfile
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# Fixed timestamp so repeated builds produce byte-identical tarballs.
MTIME = 1700000000

# Paths under "/" that must be executable.
EXE_DIRS = ("usr/bin/", "usr/sbin/", "usr/libexec/rpcd/", "etc/init.d/", "etc/uci-defaults/")


# --------------------------------------------------------------- makefile ---

def parse_makefile(path):
    """Return (vars, blocks). blocks maps 'define X' headers to their body."""
    with open(path, "r", encoding="utf-8") as fh:
        text = fh.read()

    # Drop the $(eval ...) tail and any includes; we only want assignments.
    # Leading whitespace is tolerated because variables inside
    # "define Package/foo" blocks are indented in OpenWrt makefiles.
    variables = {}
    for match in re.finditer(r"^[ \t]*([A-Za-z_][A-Za-z0-9_]*)\s*:?=\s*(.*)$", text, re.M):
        name, value = match.group(1), match.group(2).strip()
        if not value or value.startswith("$("):
            continue
        variables[name] = value

    blocks = {}
    for match in re.finditer(r"^define\s+([^\s]+)[ \t]*\n(.*?)^endef[ \t]*$",
                             text, re.M | re.S):
        blocks[match.group(1)] = match.group(2)

    # Block headers are often written as "Package/$(PKG_NAME)/postinst", so
    # expand them before the callers look keys up by resolved package name.
    blocks = {expand(k, variables): v for k, v in blocks.items()}
    return variables, blocks


def expand(value, variables, depth=0):
    """Resolve $(VAR) references using values from the same Makefile."""
    if depth > 8:
        return value

    def repl(match):
        return variables.get(match.group(1), match.group(0))

    new = re.sub(r"\$\((\w+)\)", repl, value)
    return new if new == value else expand(new, variables, depth + 1)


def depends_to_ipk(raw):
    """'DEPENDS:=@aarch64 +ca-bundle' -> 'ca-bundle'.

    '@arch' entries are menuconfig constraints, not runtime dependencies, so
    they are dropped; '+' means "select this package".
    """
    out = []
    for token in (raw or "").split():
        if token.startswith("@") or token in ("+",):
            continue
        if token.startswith("+"):
            token = token[1:]
        if token:
            out.append(token)
    return ", ".join(out)


# ----------------------------------------------------------------- tar/ar ---

def _normalize(ti, mode):
    ti.uid = 0
    ti.gid = 0
    ti.uname = "root"
    ti.gname = "root"
    ti.mtime = MTIME
    ti.mode = mode
    return ti


CONTROL_SCRIPTS = ("preinst", "postinst", "prerm", "postrm")


def tar_gz_from_dir(src, out, prefix="./"):
    """Create out (gzipped tar) from the contents of src."""
    entries = []
    for dirpath, dirnames, filenames in os.walk(src):
        dirnames.sort()
        for name in sorted(dirnames):
            entries.append(("d", os.path.join(dirpath, name)))
        for name in sorted(filenames):
            entries.append(("f", os.path.join(dirpath, name)))

    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tf:
        for kind, full in entries:
            rel = os.path.relpath(full, src).replace(os.sep, "/")
            arc = prefix + rel
            if kind == "d":
                ti = tarfile.TarInfo(arc + "/")
                ti.type = tarfile.DIRTYPE
                tf.addfile(_normalize(ti, 0o755))
            else:
                ti = _normalize(tf.gettarinfo(full, arc), 0o644)
                if any(("/" + rel).startswith("/" + d) or rel.startswith(d) for d in EXE_DIRS) \
                        or rel.endswith((".init", ".defaults")) \
                        or os.path.basename(rel) in CONTROL_SCRIPTS:
                    ti.mode = 0o755
                with open(full, "rb") as fh:
                    tf.addfile(ti, fh)

    with open(out, "wb") as fh:
        fh.write(gzip.compress(buf.getvalue(), mtime=MTIME))


def write_ipk(path, debian_binary, data_tar_gz, control_tar_gz):
    """Write the ipk container: a gzipped tar of the three members.

    The container is *not* a Unix "ar" archive. Modern OpenWrt ships ipk files
    as gzip(tar(./debian-binary, ./data.tar.gz, ./control.tar.gz)) -- verified
    against official packages from downloads.openwrt.org (23.05.5, 24.10.3).
    opkg rejects an ar archive passed to it here with
    "pkg_init_from_file: Malformed package file".
    """
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tf:
        root = tarfile.TarInfo("./")
        root.type = tarfile.DIRTYPE
        tf.addfile(_normalize(root, 0o755))
        for name, payload in (("./debian-binary", debian_binary),
                              ("./data.tar.gz", data_tar_gz),
                              ("./control.tar.gz", control_tar_gz)):
            ti = tarfile.TarInfo(name)
            ti.size = len(payload)
            tf.addfile(_normalize(ti, 0o644), io.BytesIO(payload))
    with open(path, "wb") as fh:
        fh.write(gzip.compress(buf.getvalue(), mtime=MTIME))


# --------------------------------------------------------------- builders ---

def build_control(variables, blocks, pkg, arch, installed_size):
    """Return (control_bytes, conffiles_bytes_or_None)."""
    # LuCI packages describe themselves with LUCI_TITLE / LUCI_DESCRIPTION
    # (consumed by feeds/luci/luci.mk) rather than TITLE + a description block.
    title = expand(variables.get("TITLE") or variables.get("LUCI_TITLE") or "", variables)
    desc = blocks.get("Package/%s/description" % pkg) or variables.get("LUCI_DESCRIPTION") or ""
    desc_lines = [l.strip() for l in desc.strip("\n").split("\n")]
    # Drop a leading line that merely repeats the short description.
    while desc_lines and (not desc_lines[0] or desc_lines[0] == title.strip()):
        desc_lines.pop(0)
    # Every long-description line needs a leading space; a bare empty line
    # would terminate the field, so blank lines are written as " ."
    desc = "\n".join((" " + l) if l else " ." for l in desc_lines)

    depends = depends_to_ipk(expand(variables.get("DEPENDS", ""), variables)) or \
        depends_to_ipk(expand(variables.get("LUCI_DEPENDS", ""), variables))

    lines = [
        "Package: %s" % pkg,
        "Version: %s-%s" % (variables.get("PKG_VERSION"), variables.get("PKG_RELEASE")),
    ]
    if depends:
        lines.append("Depends: %s" % depends)
    lines += [
        "License: %s" % variables.get("PKG_LICENSE", "Apache-2.0"),
        "Section: %s" % variables.get("SECTION", "net"),
        "Architecture: %s" % arch,
        "Installed-Size: %d" % installed_size,
        "Maintainer: %s" % variables.get("PKG_MAINTAINER", "local"),
    ]
    if variables.get("PROVIDES"):
        lines.append("Provides: %s" % expand(variables["PROVIDES"], variables))
    if variables.get("CONFLICTS"):
        lines.append("Conflicts: %s" % expand(variables["CONFLICTS"], variables))
    if variables.get("PKG_SOURCE_URL"):
        lines.append("Source: %s" % expand(variables["PKG_SOURCE_URL"], variables))
    lines.append("Description: %s"
                 % (title or (desc_lines[0] if desc_lines else pkg)))
    if desc:
        lines.append(desc)

    control = ("\n".join(lines) + "\n").encode("utf-8")

    conffiles = None
    cf = blocks.get("Package/%s/conffiles" % pkg)
    if cf and cf.strip():
        conffiles = ("\n".join(l for l in cf.strip().split("\n") if l.strip()) + "\n").encode()
    return control, conffiles


def pack_ipk(outdir, pkg, version, release, arch, data_dir, control, conffiles,
             postinst=None, prerm=None):
    """Assemble data/control tarballs into <outdir>/<pkg>_<ver>-<rel>_<arch>.ipk."""
    os.makedirs(outdir, exist_ok=True)
    tmp = tempfile.mkdtemp(prefix="mkipk-")
    try:
        ctl_dir = os.path.join(tmp, "control")
        os.makedirs(ctl_dir)
        with open(os.path.join(ctl_dir, "control"), "wb") as fh:
            fh.write(control)
        if conffiles:
            with open(os.path.join(ctl_dir, "conffiles"), "wb") as fh:
                fh.write(conffiles)
        for name, body in (("postinst", postinst), ("prerm", prerm)):
            if body:
                path = os.path.join(ctl_dir, name)
                with open(path, "wb") as fh:
                    fh.write(body)
                os.chmod(path, 0o755)

        ctl_tar = os.path.join(tmp, "control.tar.gz")
        data_tar = os.path.join(tmp, "data.tar.gz")
        tar_gz_from_dir(ctl_dir, ctl_tar)
        tar_gz_from_dir(data_dir, data_tar)

        ipk = os.path.join(outdir, "%s_%s-%s_%s.ipk" % (pkg, version, release, arch))
        with open(ctl_tar, "rb") as fh:
            control_tar_gz = fh.read()
        with open(data_tar, "rb") as fh:
            data_tar_gz = fh.read()
        write_ipk(ipk, b"2.0\n", data_tar_gz, control_tar_gz)
        return ipk
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def unindent(text):
    """Strip the leading tab that OpenWrt makefiles put inside define blocks."""
    if not text:
        return None
    lines = text.strip("\n").split("\n")
    out = "\n".join(re.sub(r"^\t", "", l) for l in lines)
    # Makefile escaping: $${VAR} -> ${VAR}
    return (out.replace("$${", "${") + "\n").encode("utf-8")


# ------------------------------------------------------------------- main ---

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--outdir", default=os.path.join(ROOT, "bin"))
    ap.add_argument("--arch", default="aarch64_cortex-a53")
    ap.add_argument("--binary", default=None,
                    help="pre-stripped rqbit binary to package "
                         "(default: download PKG_SOURCE and verify PKG_HASH)")
    ap.add_argument("--cache-dir", default=os.path.join(HERE, ".cache"))
    args = ap.parse_args()

    built = []

    # ---------------------------------------------------------- rqbit ------
    rq_mk = os.path.join(ROOT, "rqbit", "Makefile")
    rq_vars, rq_blocks = parse_makefile(rq_mk)
    name = rq_vars["PKG_NAME"]

    if args.binary:
        binary = args.binary
    else:
        url = expand(rq_vars["PKG_SOURCE_URL"], rq_vars) + "/" + rq_vars["PKG_SOURCE"]
        os.makedirs(args.cache_dir, exist_ok=True)
        binary = os.path.join(args.cache_dir, rq_vars["PKG_SOURCE"])
        if not os.path.exists(binary):
            print("downloading %s" % url, file=sys.stderr)
            urllib.request.urlretrieve(url, binary)
        digest = hashlib.sha256(open(binary, "rb").read()).hexdigest()
        if digest != rq_vars["PKG_HASH"]:
            sys.exit("sha256 mismatch for %s:\n  expected %s\n  got      %s"
                     % (rq_vars["PKG_SOURCE"], rq_vars["PKG_HASH"], digest))
        print("sha256 verified: %s" % digest, file=sys.stderr)

    data = tempfile.mkdtemp(prefix="rqbit-data-")
    try:
        os.makedirs(os.path.join(data, "usr/bin"))
        shutil.copy(binary, os.path.join(data, "usr/bin/rqbit"))
        os.chmod(os.path.join(data, "usr/bin/rqbit"), 0o755)

        os.makedirs(os.path.join(data, "etc/init.d"))
        shutil.copy(os.path.join(ROOT, "rqbit/files/rqbit.init"),
                    os.path.join(data, "etc/init.d/rqbit"))
        os.chmod(os.path.join(data, "etc/init.d/rqbit"), 0o755)

        os.makedirs(os.path.join(data, "etc/config"))
        shutil.copy(os.path.join(ROOT, "rqbit/files/rqbit.config"),
                    os.path.join(data, "etc/config/rqbit"))

        os.makedirs(os.path.join(data, "etc/uci-defaults"))
        shutil.copy(os.path.join(ROOT, "rqbit/files/99-rqbit-defaults"),
                    os.path.join(data, "etc/uci-defaults/99-rqbit-defaults"))
        os.chmod(os.path.join(data, "etc/uci-defaults/99-rqbit-defaults"), 0o755)

        size = sum(os.path.getsize(os.path.join(d, f))
                   for d, _, fs in os.walk(data) for f in fs)
        control, conffiles = build_control(rq_vars, rq_blocks, name, args.arch,
                                           (size + 1023) // 1024)
        built.append(pack_ipk(args.outdir, name, rq_vars["PKG_VERSION"],
                              rq_vars["PKG_RELEASE"], args.arch, data, control,
                              conffiles,
                              unindent(rq_blocks.get("Package/%s/postinst" % name)),
                              unindent(rq_blocks.get("Package/%s/prerm" % name))))
    finally:
        shutil.rmtree(data, ignore_errors=True)

    # --------------------------------------------------- luci-app-rqbit ----
    lc_mk = os.path.join(ROOT, "luci-app-rqbit", "Makefile")
    lc_vars, lc_blocks = parse_makefile(lc_mk)
    lcname = lc_vars["PKG_NAME"]

    data = tempfile.mkdtemp(prefix="luci-data-")
    try:
        src_root = os.path.join(ROOT, "luci-app-rqbit", "root")
        for dirpath, dirnames, filenames in os.walk(src_root):
            for name in filenames:
                full = os.path.join(dirpath, name)
                rel = os.path.relpath(full, src_root).replace(os.sep, "/")
                dst = os.path.join(data, rel)
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                shutil.copy(full, dst)
                mode = 0o755 if (
                    rel.startswith(EXE_DIRS)
                    or "/init.d/" in "/" + rel
                    or "/rpcd/" in "/" + rel
                ) else 0o644
                os.chmod(dst, mode)

        src_htdocs = os.path.join(ROOT, "luci-app-rqbit", "htdocs/luci-static")
        for dirpath, dirnames, filenames in os.walk(src_htdocs):
            for name in filenames:
                full = os.path.join(dirpath, name)
                rel = os.path.relpath(full, src_htdocs).replace(os.sep, "/")
                dst = os.path.join(data, "www/luci-static", rel)
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                shutil.copy(full, dst)
                os.chmod(dst, 0o644)

        size = sum(os.path.getsize(os.path.join(d, f))
                   for d, _, fs in os.walk(data) for f in fs)
        control, conffiles = build_control(lc_vars, lc_blocks, lcname, "all",
                                           (size + 1023) // 1024)

        built.append(pack_ipk(args.outdir, lcname, lc_vars["PKG_VERSION"],
                              lc_vars["PKG_RELEASE"], "all", data, control,
                              conffiles,
                              unindent(lc_blocks.get("Package/%s/postinst" % lcname)),
                              unindent(lc_blocks.get("Package/%s/prerm" % lcname))))
    finally:
        shutil.rmtree(data, ignore_errors=True)

    for path in built:
        print("%s  %d bytes" % (path, os.path.getsize(path)))


if __name__ == "__main__":
    main()
