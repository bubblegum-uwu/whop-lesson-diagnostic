import { hashPassword } from "../src/lib/passwordHash.js";

/**
 * One-time owner setup utility for Phase 4D's Knovera login — prompts for
 * the password interactively and prints only the resulting scrypt hash,
 * which is what actually gets set as KNOVERA_PASSWORD_HASH. The plaintext
 * password itself is never logged, written to a file, or passed as a
 * command-line argument (arguments are visible to other processes on the
 * same machine via `ps`).
 *
 * Usage (run in a real terminal, not piped):
 *   npx tsx scripts/generateKnoveraPasswordHash.ts
 *
 * Hides the typed characters via stdin raw mode — read one keystroke at a
 * time and never write it back — the standard, dependency-free technique
 * for a non-echoing terminal prompt in Node.js. Requires a real TTY
 * (`process.stdin.isTTY`); when stdin isn't a TTY (e.g. piped input, as in
 * a test harness) this falls back to a plain, ECHOED prompt instead of
 * silently pretending to hide input it can't actually hide — a clear
 * warning is printed either way so the fallback is never mistaken for the
 * hidden-input path.
 */
const CTRL_C = String.fromCharCode(3);
const DELETE = String.fromCharCode(127);

function readPasswordHidden(promptText: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(promptText);
    const wasRaw = stdin.isRaw;
    stdin.resume();
    stdin.setEncoding("utf8");
    stdin.setRawMode(true);

    let input = "";
    function cleanup() {
      stdin.setRawMode(wasRaw ?? false);
      stdin.pause();
      stdin.removeListener("data", onData);
    }
    function onData(char: string) {
      if (char === CTRL_C) {
        cleanup();
        process.stdout.write("\n");
        reject(new Error("Cancelled."));
        return;
      }
      if (char === "\r" || char === "\n") {
        cleanup();
        process.stdout.write("\n");
        resolve(input);
        return;
      }
      if (char === DELETE || char === "\b") {
        input = input.slice(0, -1);
        return;
      }
      input += char;
      // Deliberately no echo — this is the entire point.
    }
    stdin.on("data", onData);
  });
}

/**
 * Non-interactive fallback for when stdin isn't a real TTY (piped input —
 * e.g. this script's own test coverage, or a caller scripting it). Reads
 * the two newline-separated lines (password, then confirmation) from a
 * single bulk read rather than two sequential `readline.question()` calls:
 * Node's `readline` can close its interface as soon as piped stdin hits
 * EOF, which silently drops a second `question()` call's input on a
 * non-TTY stream — reading once up front avoids that race entirely. This
 * path is always ECHOED (there is no terminal to suppress echo on) and
 * always warns before use.
 */
function readTwoLinesFromPipedStdin(): Promise<[string, string]> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    process.stdin.on("end", () => {
      const lines = Buffer.concat(chunks).toString("utf8").split(/\r\n|\n/);
      if (lines.length < 2) {
        reject(new Error("Expected two lines of piped input (password, then confirmation)."));
        return;
      }
      resolve([lines[0], lines[1]]);
    });
    process.stdin.on("error", reject);
  });
}

async function main(): Promise<void> {
  const canHideInput = Boolean(process.stdin.isTTY);
  let password: string;
  let confirm: string;
  if (canHideInput) {
    password = await readPasswordHidden("Knovera operator password: ");
    confirm = await readPasswordHidden("Confirm password: ");
  } else {
    console.warn(
      "WARNING: stdin is not an interactive terminal, so input cannot be hidden — whatever you piped in was visible wherever it came from. " +
        "Run this script directly in a real terminal (not piped/redirected) to keep it hidden.",
    );
    [password, confirm] = await readTwoLinesFromPipedStdin();
  }

  if (password !== confirm) {
    console.error("Passwords did not match. Nothing was printed — run the script again.");
    process.exitCode = 1;
    return;
  }
  if (password.length === 0) {
    console.error("Password was empty. Nothing was printed — run the script again.");
    process.exitCode = 1;
    return;
  }

  const hash = await hashPassword(password);
  console.log("\nSet this as the KNOVERA_PASSWORD_HASH secret (do not commit it, do not paste it into chat/logs):\n");
  console.log(hash);
}

main().catch((err) => {
  console.error("Failed to generate password hash:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
