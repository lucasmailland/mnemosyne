/**
 * Shell completion script generator for the `mnemo` CLI.
 * Supports bash, zsh, fish, and PowerShell (pwsh).
 *
 * Usage:
 *   mnemo completion bash   → source <(mnemo completion bash)
 *   mnemo completion zsh    → source <(mnemo completion zsh)
 *   mnemo completion fish   → mnemo completion fish > ~/.config/fish/completions/mnemo.fish
 *   mnemo completion pwsh   → Invoke-Expression (mnemo completion pwsh)
 */

import { t } from "./i18n/index.js";

interface CmdEntry {
  name: string;
  desc: string;
}

const CMDS: CmdEntry[] = [
  { name: "recall", desc: "Search memory (top 10 hits)" },
  { name: "remember", desc: "Store a new memory" },
  { name: "forget", desc: "Delete a memory by ID" },
  { name: "list", desc: "List recent facts (default 20)" },
  { name: "search", desc: "Full-text search without Claude" },
  { name: "show", desc: "Show all fields of a fact as JSON" },
  { name: "status", desc: "Show server health (alias for health)" },
  { name: "health", desc: "Show 3-tier health probe" },
  { name: "sessions", desc: "List open sessions" },
  { name: "episode", desc: "Start or collapse an episode" },
  { name: "tasks", desc: "List/create/update/delegate tasks" },
  { name: "events", desc: "List/create/show/archive events" },
  { name: "decide", desc: "Create/list/show/supersede decisions" },
  { name: "entity", desc: "Create/list/show/update entities, list linked facts" },
  { name: "relate", desc: "Create a relation, or list relations" },
  { name: "strategy", desc: "Create/list/show/update/archive/rate strategies" },
  { name: "workflow", desc: "Create/list/show workflows" },
  { name: "skill", desc: "Create/list/show skills" },
  { name: "reasoning", desc: "Create/list/show/resolve/record reasoning chains" },
  { name: "hyperedge", desc: "Create/list/show/update/archive hyperedges" },
  { name: "pin", desc: "Pin a fact to prevent decay" },
  { name: "unpin", desc: "Unpin a fact" },
  { name: "timeline", desc: "Recent fact-lifecycle events" },
  { name: "judge", desc: "List/resolve conflicting fact pairs" },
  { name: "purge", desc: "Hard-delete a fact or all closed facts (irreversible)" },
  { name: "erase", desc: "GDPR crypto-erasure of a user's or actor's keys (irreversible)" },
  { name: "consolidate", desc: "Trigger memory consolidation" },
  { name: "remind", desc: "Create/list/dismiss reminders" },
  { name: "export", desc: "Download workspace memory as gzip JSONL to stdout" },
  { name: "import", desc: "Upload a gzip JSONL export file" },
  { name: "login", desc: "Interactive login — saves URL + API key" },
  { name: "init", desc: "Setup wizard — configure server + MCP clients" },
  { name: "install", desc: "Install Mnemosyne into all detected AI coding agents" },
  { name: "info", desc: "Show full session context" },
  { name: "whoami", desc: "Alias for info" },
  { name: "doctor", desc: "Run server-side diagnostics" },
  { name: "harness", desc: "Inspect and recover the local capture queue" },
  { name: "workspace", desc: "List workspaces / members" },
  { name: "keys", desc: "Manage API keys (list/create/revoke/show/rotate)" },
  { name: "link", desc: "Link this repo to the active workspace" },
  { name: "reset", desc: "Safe reset check for a workspace (non-production)" },
  { name: "version", desc: "Print CLI version" },
  { name: "config", desc: "Manage configuration (set/get)" },
  { name: "help", desc: "Show help" },
  { name: "completion", desc: "Output shell completion script" },
];

const CMD_NAMES = CMDS.map((c) => c.name).join(" ");

function bashScript(): string {
  return `# mnemo bash completion
# Source in your shell:  source <(mnemo completion bash)
# Or install system-wide: mnemo completion bash | sudo tee /etc/bash_completion.d/mnemo

_mnemo_completion() {
  local cur prev
  cur="$\{COMP_WORDS[COMP_CWORD]}"
  prev="$\{COMP_WORDS[COMP_CWORD-1]}"

  case "$prev" in
    config)
      COMPREPLY=($(compgen -W "set get" -- "$cur"))
      return ;;
    completion)
      COMPREPLY=($(compgen -W "bash zsh fish pwsh" -- "$cur"))
      return ;;
    import)
      COMPREPLY=($(compgen -f -X '!*.jsonl.gz' -- "$cur"))
      return ;;
  esac

  COMPREPLY=($(compgen -W "${CMD_NAMES}" -- "$cur"))
}

complete -F _mnemo_completion mnemo
`;
}

function zshScript(): string {
  const cmdList = CMDS.map((c) => `        '${c.name}:${c.desc}'`).join("\n");
  return `#compdef mnemo
# mnemo zsh completion
# Source in your shell:  source <(mnemo completion zsh)
# Or drop into a $fpath directory and run compinit.

_mnemo() {
  local state

  _arguments \\\\
    '1:command:->command' \\\\
    '*::arg:->arg'

  case "$state" in
    command)
      local cmds=(
${cmdList}
      )
      _describe 'command' cmds
      ;;
    arg)
      case "$\{words[1]}" in
        config)
          local sub=('set:Set a config value (keys: url, apiKey)' 'get:Get config value(s)')
          _describe 'subcommand' sub
          ;;
        completion)
          local shells=('bash:Bash completion' 'zsh:Zsh completion' 'fish:Fish completion' 'pwsh:PowerShell completion')
          _describe 'shell' shells
          ;;
        import)
          _files -g '*.jsonl.gz'
          ;;
      esac
      ;;
  esac
}

_mnemo "$@"
`;
}

function fishScript(): string {
  const topLevel = CMDS.map(
    (c) =>
      `complete -c mnemo -n 'not __fish_seen_subcommand_from ${CMD_NAMES}' -a '${c.name.padEnd(10)}' -d '${c.desc}'`
  ).join("\n");
  return `# mnemo fish completion
# Install: mnemo completion fish > ~/.config/fish/completions/mnemo.fish

complete -c mnemo -f

${topLevel}

# config subcommands
complete -c mnemo -n '__fish_seen_subcommand_from config' -a 'set' -d 'Set a config value (keys: url, apiKey)'
complete -c mnemo -n '__fish_seen_subcommand_from config' -a 'get' -d 'Get config value(s)'

# completion shell argument
complete -c mnemo -n '__fish_seen_subcommand_from completion' -a 'bash' -d 'Bash completion script'
complete -c mnemo -n '__fish_seen_subcommand_from completion' -a 'zsh'  -d 'Zsh completion script'
complete -c mnemo -n '__fish_seen_subcommand_from completion' -a 'fish' -d 'Fish completion script'
complete -c mnemo -n '__fish_seen_subcommand_from completion' -a 'pwsh' -d 'PowerShell completion script'

# import file argument
complete -c mnemo -n '__fish_seen_subcommand_from import' -F -a '*.jsonl.gz'
`;
}

function pwshScript(): string {
  const nameList = CMDS.map((c) => `'${c.name}'`).join(",");
  return `# mnemo PowerShell completion
# Add to $PROFILE: Invoke-Expression (mnemo completion pwsh)

Register-ArgumentCompleter -Native -CommandName mnemo -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $cmds = @(${nameList})
  $elems = $commandAst.CommandElements

  if ($elems.Count -le 2) {
    $cmds | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
      [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
    }
  } elseif ($elems.Count -eq 3) {
    switch ($elems[1].Value) {
      'config' {
        @('set','get') | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
          [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
        }
      }
      'completion' {
        @('bash','zsh','fish','pwsh') | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
          [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
        }
      }
    }
  }
}
`;
}

export const COMPLETION_SHELLS = ["bash", "zsh", "fish", "pwsh"] as const;
export type CompletionShell = (typeof COMPLETION_SHELLS)[number];

export function generateCompletion(shell: string): string {
  switch (shell) {
    case "bash":
      return bashScript();
    case "zsh":
      return zshScript();
    case "fish":
      return fishScript();
    case "pwsh":
      return pwshScript();
    default:
      throw new Error(
        t("completion.unknownShell", { shell, shells: COMPLETION_SHELLS.join(", ") })
      );
  }
}
