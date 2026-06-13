# Vendor tree

`vendor/qemu-wasm` is intentionally not committed. It is a git checkout of
https://github.com/ktock/qemu-wasm pinned at:

    0ef7b4e2814b231705d8371dd7997f5b72e70baf

To recreate it:

    git clone https://github.com/ktock/qemu-wasm vendor/qemu-wasm
    git -C vendor/qemu-wasm checkout 0ef7b4e2814b231705d8371dd7997f5b72e70baf
    git -C vendor/qemu-wasm apply ../../scripts/patches/vendor-worktree-state.diff

`scripts/patches/vendor-worktree-state.diff` is a snapshot of the exact local
modifications present in the working vendor tree when the first full A/UX
boot-to-desktop succeeded (June 13, 2026). The individual feature patches in
`scripts/patches/*.patch` are applied selectively by the `build-qemu-*`
Makefile targets; the worktree-state diff is the known-good union.

Large runtime artifacts policy:

- `public/qemu-lazy/qemu-system-m68k.wasm` (28 MB) IS committed: it is the
  known-good runtime that boots A/UX, and rebuilding it requires the Docker
  plus Emscripten pipeline.
- `*.data` packs are NOT committed (they embed the Apple Quadra 800 ROM).
- Disk images (`assets/`, `*.img`) are NOT committed (size and copyright).
  Recreate the lazy pack with `make package-lazy` after placing
  `AUX3.img`, `pram-aux.img`, and `Quadra800.ROM` in `assets/`.
