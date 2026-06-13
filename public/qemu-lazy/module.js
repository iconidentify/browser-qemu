(function (root) {
var runtimeDir = "qemu-lazy";
var args = [
  "-M", "q800",
  "-m", "128",
  "-accel", "tcg,tb-size=500",
  "-snapshot",
  "-L", "/pack/",
  "-bios", "/pack/Quadra800.rom",
  "-display", "sdl,gl=off,show-cursor=on",
  "-g", "1152x870x8",
  "-audio", "none",
  "-drive", "file=/pack/pram.img,format=raw,if=mtd,file.locking=off",
  "-drive", "file=/pack/aux-3.1.1-disk.img,media=disk,format=raw,if=none,id=hd2,file.locking=off,snapshot=on,cache=unsafe",
  "-device", "scsi-hd,scsi-id=1,drive=hd2",
  "-nic", "none",
  "-monitor", "stdio",
  "-serial", "none"
];

function lazyUrl(name) {
  var base = root.location ? root.location.href : "";
  return new URL("./" + runtimeDir + "/" + name, base).href;
}

function mountLazyDisks(Module) {
  Module.FS_createPath("/", "pack", true, true);
  /* Writable only when the shell confirmed disk write mode (disk=rw with
     verified relay auth); guest writes then flow through the disk worker. */
  Module.FS_createLazyFile("/pack", "aux-3.1.1-disk.img", lazyUrl("aux-3.1.1-disk.img"), true, root.AuxQemuDiskWritable === true);
}

root.AuxQemuModuleArguments = args;
root.Module = root.Module || {};
root.Module.arguments = args;
root.Module.preRun = root.Module.preRun || [];
root.Module.preRun.push(mountLazyDisks);
})(typeof window !== "undefined" ? window : globalThis);
