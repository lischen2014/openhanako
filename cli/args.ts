const COMMANDS = new Set(["serve", "status", "sessions", "continue", "chat", "bundle", "help"]);
const BUNDLE_SUBCOMMANDS = new Set(["pull", "status"]);
const CHANNELS = new Set(["stable", "beta"]);

export function parseCliArgs(argv = []) {
  const args = Array.from(argv);
  const command = args[0] && !args[0].startsWith("-") ? args.shift() : "help";
  if (!COMMANDS.has(command)) {
    return { command: "help", error: `unknown command: ${command}` };
  }

  const result = {
    command,
    subcommand: null,
    channel: "stable",
    plain: false,
    url: null,
    token: null,
    session: null,
    target: null,
    allowDataDowngrade: false,
    passthrough: [],
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--plain") {
      result.plain = true;
    } else if (arg === "--allow-data-downgrade") {
      result.allowDataDowngrade = true;
    } else if (arg === "--url") {
      result.url = requireValue(args, ++i, "--url");
    } else if (arg === "--token") {
      result.token = requireValue(args, ++i, "--token");
    } else if (arg === "--session") {
      result.session = requireValue(args, ++i, "--session");
    } else if (arg === "--channel") {
      const value = requireValue(args, ++i, "--channel");
      if (!CHANNELS.has(value)) {
        throw new Error(`--channel must be one of: stable, beta (got ${value})`);
      }
      result.channel = value;
    } else if (arg === "--") {
      result.passthrough = args.slice(i + 1);
      break;
    } else if (command === "continue" && !result.target) {
      result.target = arg;
    } else if (command === "bundle" && !result.subcommand && !arg.startsWith("-")) {
      result.subcommand = arg;
    } else {
      result.passthrough.push(arg);
    }
  }

  if (command === "bundle" && !BUNDLE_SUBCOMMANDS.has(result.subcommand)) {
    return {
      command: "help",
      error: result.subcommand
        ? `unknown bundle subcommand: ${result.subcommand} (expected pull or status)`
        : "bundle requires a subcommand: pull or status",
    };
  }

  return result;
}

function requireValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function helpText() {
  return `Hana CLI

Usage:
  hana serve [-- server args]        Start a headless HanaAgent Server (serves the --channel web frontend, if pulled)
  hana status                       Show local server and agent status
  hana sessions                     List recent sessions
  hana continue [index|path]        Continue a recent session
  hana chat [--plain]               Open chat
  hana bundle pull                  Pull and activate the latest web frontend
  hana bundle status                Show the pulled web frontend status

Connection options:
  --url <baseUrl>                   Connect to a specific HanaAgent Server
  --token <token>                   Bearer token for that server
  --session <path>                  Chat in a specific session

Serve options:
  --allow-data-downgrade            Allow this kernel to open a data directory a newer
                                     kernel already touched (risk of silent data corruption)

Channel options:
  --channel <stable|beta>           Release channel for hana serve and hana bundle (default: stable)
`;
}
