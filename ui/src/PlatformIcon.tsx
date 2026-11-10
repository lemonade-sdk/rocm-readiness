import linuxLogo from "./assets/platforms/linux.png";
import windowsLogo from "./assets/platforms/windows.svg";

export function PlatformIcon({ platform }: { platform: string }) {
  if (platform !== "linux" && platform !== "windows") return null;
  return <img className="platform-logo" data-platform={platform} src={platform === "linux" ? linuxLogo : windowsLogo}
    alt="" aria-hidden="true" width="18" height="18" />;
}
