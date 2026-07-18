import { execFileSync } from "node:child_process";
import { pbkdf2Sync } from "node:crypto";

if (process.platform !== "darwin") {
  console.error("이 도구는 macOS 키체인과 pbcopy를 사용합니다.");
  process.exit(1);
}

try {
  const password = execFileSync(
    "security",
    ["find-generic-password", "-s", "codex-facility-search-password", "-w"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  ).trim();
  const token = pbkdf2Sync(password, "mep-evidence-ai-access-v1", 600_000, 32, "sha256")
    .toString("base64url");
  execFileSync("pbcopy", [], { input: token, stdio: ["pipe", "ignore", "ignore"] });
  console.log("AI_ACCESS_TOKEN을 클립보드에 복사했습니다. 실제 값은 출력하지 않았습니다.");
} catch {
  console.error("공유 비밀번호를 키체인에서 읽거나 토큰을 복사하지 못했습니다.");
  process.exit(1);
}
