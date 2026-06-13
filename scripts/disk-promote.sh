#!/usr/bin/env bash
# Publish admin disk edits to the read-only disk that visitors boot.
#
# `make disk-relay` writes your changes to an editable copy under
# build/relay-disks/. This promotes that copy to the project master
# (assets/AUX3.img) so a subsequent `make package-lazy` ships your edits as
# the new read-only base image. The previous master is backed up first.
#
#   make disk-promote          # prompts before overwriting
#   make disk-promote FORCE=1  # no prompt
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DISK_NAME="${DISK_NAME:-aux-3.1.1-disk.img}"
EDITABLE="${ROOT}/build/relay-disks/bootable/${DISK_NAME}"
MASTER="${ROOT}/assets/AUX3.img"

if [[ ! -f "${EDITABLE}" ]]; then
  echo "error: no editable disk at ${EDITABLE}; run make disk-relay first" >&2
  exit 1
fi
if [[ ! -f "${MASTER}" ]]; then
  echo "error: master not found at ${MASTER}" >&2
  exit 1
fi

# Refuse to promote while the relay still holds the disk open for writes.
if lsof "${EDITABLE}" >/dev/null 2>&1; then
  echo "error: ${EDITABLE} is open (relay still running?). Stop the relay first." >&2
  exit 1
fi

EDIT_MD5="$(md5 -q "${EDITABLE}")"
MASTER_MD5="$(md5 -q "${MASTER}")"
if [[ "${EDIT_MD5}" == "${MASTER_MD5}" ]]; then
  echo "editable disk is identical to the master; nothing to promote."
  exit 0
fi

echo "promote edited disk to master:"
echo "  from: ${EDITABLE} (md5 ${EDIT_MD5})"
echo "  to:   ${MASTER} (md5 ${MASTER_MD5})"
if [[ "${FORCE:-0}" != "1" ]]; then
  read -r -p "overwrite the master image? [y/N] " reply
  case "${reply}" in
    [yY]|[yY][eE][sS]) ;;
    *) echo "aborted."; exit 1 ;;
  esac
fi

BACKUP="${MASTER}.bak-$(md5 -q "${MASTER}" | cut -c1-8)"
if [[ ! -f "${BACKUP}" ]]; then
  cp -c "${MASTER}" "${BACKUP}" 2>/dev/null || cp "${MASTER}" "${BACKUP}"
  echo "backed up previous master to ${BACKUP}"
fi

cp -c "${EDITABLE}" "${MASTER}" 2>/dev/null || cp "${EDITABLE}" "${MASTER}"
echo "promoted. now run: make package-lazy   (to ship it as the read-only disk)"
