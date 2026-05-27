/** completion — Generate shell completion scripts */
import { Command } from "commander";
import { c } from "../utils/colors";

export function register(program: Command, _shared: (c: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  const cmd = program
    .command("completion")
    .description("Print shell completion script");

  cmd
    .command("bash")
    .description("Generate Bash completion")
    .action(() => { process.stdout.write(generateCompletion("bash")); });

  cmd
    .command("zsh")
    .description("Generate Zsh completion")
    .action(() => { process.stdout.write(generateCompletion("zsh")); });

  cmd
    .command("fish")
    .description("Generate Fish completion")
    .action(() => { process.stdout.write(generateCompletion("fish")); });

  // Default: show install instructions
  cmd.action(() => {
    const lines = [
      "",
      c("bold", "Shell Completion Setup"),
      "",
      c("cyan", "Bash") + "  — Add to ~/.bashrc:",
      c("gray", '  eval "$(EvoClaw completion bash)"'),
      "",
      c("cyan", "Zsh") + "   — Add to ~/.zshrc:",
      c("gray", '  eval "$(EvoClaw completion zsh)"'),
      "",
      c("cyan", "Fish") + "  — Add to ~/.config/fish/config.fish:",
      c("gray", "  EvoClaw completion fish | source"),
      "",
      c("cyan", "PowerShell") + " — Coming soon. Use Tab completion in Web UI terminal.",
      "",
    ];
    for (const line of lines) process.stdout.write(line + "\n");
  });
}

function generateCompletion(shell: "bash" | "zsh" | "fish"): string {
  const name = "EvoClaw";
  if (shell === "bash") {
    return [
      "# EvoClaw Bash completion — add this to ~/.bashrc",
      "_evoclaw_completion() {",
      "  local cur prev words cword",
      "  _init_completion || return",
      '  COMPREPLY=($(EvoClaw complete --position "$COMP_CWORD" "${COMP_WORDS[@]}" 2>/dev/null))',
      "}",
      "complete -F _evoclaw_completion " + name,
      "",
    ].join("\n");
  }
  if (shell === "zsh") {
    return [
      "# EvoClaw Zsh completion — add this to ~/.zshrc",
      "_evoclaw_completion() {",
      "  local -a completions",
      '  completions=(${(f)"$(EvoClaw complete --position "$((CURRENT - 1))" "${words[@]}" 2>/dev/null)"})',
      "  _describe 'values' completions",
      "}",
      "compdef _evoclaw_completion " + name,
      "",
    ].join("\n");
  }
  // Fish
  return [
    "# EvoClaw Fish completion — add this to ~/.config/fish/config.fish",
    "function _evoclaw_completion",
    "  EvoClaw complete --position (math (count (commandline -poc)) + 1) (commandline -poc) 2>/dev/null",
    "end",
    'complete -c ' + name + ' -f -a "(_evoclaw_completion)"',
    "",
  ].join("\n");
}