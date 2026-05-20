/**
 * SkillSafe Security Scanner — TypeScript port.
 *
 * Stage 1: Deterministic regex-based scanner that lists ALL findings
 * without scoring or classifying them. Produces raw findings + BOM.
 * Stage 2 (AI review) handles classification, scoring, and verdicts.
 *
 * 12 scan passes:
 *  1. Python dangerous calls (regex)
 *  2. JS/TS dangerous calls (regex)
 *  3. Secret detection
 *  4. Prompt injection + inducement language
 *  5. Shell/general threat patterns
 *  6. Binary file detection
 *  7. base64 deep-scan
 *  8. Unicode obfuscation
 *  9. Structural mimicry
 * 10. Composite capability co-occurrence
 * 11. Surplus functionality
 * 12. BOM (Bill of Materials)
 */

export const SCANNER_VERSION = "1.1.0";
export const RULESET_VERSION = "2026.04.20";
export const SCANNER_TOOL = "skillsafe-scanner";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FileEntry {
  path: string;
  content: string;
  size: number;
}

export interface RawFinding {
  rule_id: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  file: string;
  line: number;
  message: string;
  context?: string;
}

export interface BomReport {
  schema_version: "1.0";
  file_access: {
    reads: BomEntry[];
    writes: BomEntry[];
    deletes: BomEntry[];
    creates: BomEntry[];
  };
  network: {
    urls: BomEntry[];
    domains: string[];
    protocols: string[];
  };
  environment: {
    env_vars: BomEntry[];
    binaries: BomEntry[];
    system_commands: BomEntry[];
  };
  permissions: {
    capabilities_used: string[];
    risk_surface: string;
  };
  data_flow: {
    inputs: Array<{ type: string; name?: string; path?: string }>;
    outputs: Array<{ type: string; path?: string; domain?: string }>;
  };
  dependencies: {
    python_imports: string[];
    js_requires: string[];
    shell_tools: string[];
  };
  summary: {
    total_files_scanned: number;
    files_with_capabilities: number;
    capability_count: Record<string, number>;
    risk_surface: string;
  };
}

interface BomEntry {
  file: string;
  line: number;
  [key: string]: unknown;
}

export interface ScanResult {
  schema_version: "2.0";
  scanner: { tool: string; version: string; ruleset_version: string };
  raw_findings: RawFinding[];
  bom: BomReport;
  file_count: number;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// File extension sets
// ---------------------------------------------------------------------------

const TEXT_EXTENSIONS = new Set([
  ".py", ".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs",
  ".md", ".txt", ".json", ".yaml", ".yml", ".toml",
  ".sh", ".bash", ".zsh", ".fish",
  ".html", ".css", ".xml", ".csv",
  ".env", ".cfg", ".ini", ".conf",
  ".rst",
]);

const SCRIPT_EXTENSIONS = new Set([
  ".py", ".sh", ".bash", ".zsh", ".fish", ".js", ".ts", ".mjs", ".cjs",
]);

const INJECTION_EXTENSIONS = new Set([".md", ".txt", ".yaml", ".yml", ".rst"]);

const JS_EXTENSIONS = new Set([".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs"]);

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".bmp", ".svg",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z",
  ".exe", ".dll", ".so", ".dylib",
  ".mp3", ".mp4", ".wav", ".avi", ".mov",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx",
  ".pyc", ".pyo", ".class",
]);

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

type PatternDef = [string, string, RawFinding["severity"], string];

// Pass 1: Python dangerous calls (regex approximation of AST analysis)
// Severity: info — these are capability indicators for BOM, not threats by themselves.
// Actual threats arise from composite rules (exec+exfil) or surplus functionality.
const PY_PATTERNS: PatternDef[] = [
  [String.raw`\beval\s*\(`, "py_eval", "info", "eval() can execute arbitrary code"],
  [String.raw`\bexec\s*\(`, "py_exec", "info", "exec() can execute arbitrary code"],
  [String.raw`\bcompile\s*\(`, "py_compile", "info", "compile() can compile arbitrary code"],
  [String.raw`\b__import__\s*\(`, "py_dunder_import", "info", "__import__() enables dynamic imports"],
  [String.raw`importlib\.import_module\s*\(`, "py_importlib", "info", "importlib.import_module() enables dynamic imports"],
  [String.raw`os\.system\s*\(`, "py_os_system", "info", "os.system() executes shell commands"],
  [String.raw`os\.popen\s*\(`, "py_os_popen", "info", "os.popen() executes shell commands"],
  [String.raw`subprocess\.(?:call|run|Popen|check_output|check_call|getoutput|getstatusoutput)\s*\(`, "py_subprocess", "info", "subprocess executes external commands"],
];

// Pass 2: JS/TS dangerous calls
// Severity: info — these are capability indicators for BOM, not threats by themselves.
const JS_PATTERNS: PatternDef[] = [
  [String.raw`\beval\s*\(`, "js_eval", "info", "eval() can execute arbitrary code"],
  [String.raw`\bnew\s+Function\s*\(`, "js_function_constructor", "info", "Function() constructor can execute arbitrary code"],
  [String.raw`require\s*\(\s*['"]child_process['"]\s*\)`, "js_child_process", "info", "child_process module enables shell command execution"],
  [String.raw`\b(?:execSync|execFileSync)\s*\(`, "js_exec_sync", "info", "execSync() executes shell commands synchronously"],
  [String.raw`\b(?:spawnSync)\s*\(`, "js_spawn_sync", "info", "spawnSync() executes external commands"],
  [String.raw`import\s+.*\bfrom\s+['"]child_process['"]`, "js_child_process_import", "info", "child_process ES module import enables shell command execution"],
  [String.raw`import\s+.*\bfrom\s+['"]fs['"]`, "js_fs_import", "info", "fs ES module import enables filesystem access"],
];

// Pass 3: Secret detection
const SECRET_PATTERNS: PatternDef[] = [
  [String.raw`AKIA[0-9A-Z]{16}`, "aws_access_key", "critical", "AWS Access Key ID detected"],
  [String.raw`-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----`, "private_key", "critical", "Private key detected"],
  [String.raw`gh[pousr]_[A-Za-z0-9_]{36,}`, "github_token", "critical", "GitHub token detected"],
  [String.raw`xox[bpars]-[0-9a-zA-Z\-]{10,}`, "slack_token", "high", "Slack token detected"],
  [String.raw`['"]?[a-zA-Z_]*(?:api[_\-]?key|secret[_\-]?key|access[_\-]?token|auth[_\-]?token|password)['"]?\s*[:=]\s*['"][a-zA-Z0-9+/=_\-]{16,}['"]`, "generic_secret", "high", "Possible hardcoded secret or API key"],
];

// Secret-bearing-file references. Distinct from SECRET_PATTERNS (which finds
// the actual secret value): these match when an artifact's code/text refers
// to a *path* known to hold credentials. Rule_id prefix `secret_path_*` so
// the feed and the keychain rewriter can govern them independently.
const SECRET_PATH_PATTERNS: PatternDef[] = [
  [String.raw`(?:[~./\w-]+/)?\.env(?:\.\w+)?\b`, "secret_path_dotenv", "medium", "Reference to a .env file"],
  [String.raw`~?/?\.aws/(?:credentials|config)\b`, "secret_path_aws", "high", "Reference to ~/.aws credentials/config"],
  [String.raw`~?/?\.ssh/id_(?:rsa|ed25519|dsa|ecdsa)\b`, "secret_path_ssh_key", "high", "Reference to an SSH private key"],
  [String.raw`~?/?\.docker/config\.json\b`, "secret_path_docker", "medium", "Reference to Docker credentials"],
  [String.raw`~?/?\.kube/config\b`, "secret_path_kube", "high", "Reference to kube config (cluster credentials)"],
  [String.raw`~?/?\.netrc\b`, "secret_path_netrc", "high", "Reference to ~/.netrc (HTTP credentials)"],
  [String.raw`(?:[~./\w-]+/)?credentials\.json\b`, "secret_path_credentials_json", "medium", "Reference to a credentials.json file"],
  [String.raw`(?:[~./\w-]+/)?service[-_]account(?:[-_.]\w+)*\.json\b`, "secret_path_gcp", "high", "Reference to a GCP service-account key"],
];

// Pass 4: Prompt injection + inducement
const INJECTION_PATTERNS: PatternDef[] = [
  [String.raw`ignore\s+(?:all\s+)?(?:(?:previous|prior|above)\s+)?instructions`, "prompt_ignore_instructions", "high", "Prompt injection: ignore instructions"],
  [String.raw`you\s+are\s+now`, "prompt_role_hijack", "high", "Prompt injection: role hijacking"],
  [String.raw`system\s+prompt`, "prompt_system_prompt", "info", "Prompt injection: system prompt reference"],
  [String.raw`disregard\s+(?:all\s+)?(?:(?:previous|prior)\s+)?instructions`, "prompt_disregard", "high", "Prompt injection: disregard instructions"],
  [String.raw`new\s+instructions\s*:`, "prompt_new_instructions", "high", "Prompt injection: new instructions block"],
  [String.raw`override\s+(?:(?:previous|prior)\s+)?instructions`, "prompt_override", "high", "Prompt injection: override instructions"],
  [String.raw`forget\s+(?:everything|all|previous)`, "prompt_forget", "high", "Prompt injection: forget instructions"],
  [String.raw`do\s+not\s+follow\s+(?:the\s+)?(?:(?:previous|prior|above)\s+)?instructions`, "prompt_do_not_follow", "high", "Prompt injection: do not follow instructions"],
  [String.raw`before\s+(?:using|running|proceeding)[,\s]+(?:run|execute|source)\b`, "inducement_before_using", "medium", "Inducement: pre-task script nudge (SS-SI01)"],
  [String.raw`for\s+(?:the\s+)?(?:tool|this\s+skill|it)\s+to\s+(?:work|function|operate)\b`, "inducement_for_tool_to_work", "medium", "Inducement: necessity framing (SS-SI02)"],
  [String.raw`this\s+(?:setup|initialization|configuration|install(?:ation)?)\s+step\s+is\s+(?:required|necessary|mandatory)\b`, "inducement_required_step", "medium", "Inducement: required-step framing (SS-SI03)"],
  [String.raw`run\s+the\s+(?:included|bundled|provided|attached)\s+(?:script|setup|installer|helper)\b`, "inducement_run_bundled", "high", "Inducement: explicit bundled-script nudge (SS-SI04)"],
  [String.raw`automatically\s+(?:run|execute|invoke)\s+\S+\.(?:sh|py|bash)\b`, "inducement_auto_exec", "high", "Inducement: automatic script execution instruction (SS-SI05)"],
  [String.raw`must\s+(?:be\s+)?(?:run|executed?|sourced?)\s+(?:before|first|prior)\b`, "inducement_must_run_first", "medium", "Inducement: mandatory pre-execution framing (SS-SI06)"],
];

// Pass 5: Shell / general threat patterns
const SHELL_THREAT_PATTERNS: PatternDef[] = [
  [String.raw`(?:curl|wget).*(?:ngrok\.io|requestbin\.com|webhook\.site|pipedream\.net|canarytokens|burpcollaborator)`, "shell_exfil_service", "high", "Data exfiltration to known collection service (SS03)"],
  [String.raw`>\s*(?:MEMORY\.md|SOUL\.md|CLAUDE\.md|\.cursorrules)`, "agent_memory_write", "high", "Writing to agent memory/instruction file (SS04)"],
  [String.raw`echo\s+.*>>?\s*(?:MEMORY\.md|SOUL\.md|CLAUDE\.md|\.cursorrules)`, "agent_memory_inject", "high", "Injecting content into agent memory file (SS04)"],
  [String.raw`\bsudo\s+(?:su|bash|sh|-s|-i)\b`, "priv_escalation_sudo", "high", "Privilege escalation via sudo shell (SS07)"],
  [String.raw`\bseteuid\s*\(\s*0\s*\)|\bsetuid\s*\(\s*0\s*\)`, "priv_setuid_root", "critical", "Setting UID/EUID to root (SS07)"],
  [String.raw`crontab\s+-[le]|@reboot|/etc/cron\b`, "persistence_cron", "high", "Persistence via cron (SS08)"],
  [String.raw`~/Library/LaunchAgents|/Library/LaunchAgents|~/Library/LaunchDaemons|/Library/LaunchDaemons`, "persistence_launchd", "high", "Persistence via macOS LaunchAgent/LaunchDaemon (SS08)"],
  [String.raw`systemctl\s+enable\s+|/etc/systemd/system/.*\.service`, "persistence_systemd", "high", "Persistence via systemd service (SS08)"],
  [String.raw`echo\s+.*>>?\s*~/?\.(bash_profile|bashrc|zshrc|profile|bash_login|zprofile)`, "persistence_shell_profile", "medium", "Modifying shell profile for persistence (SS08)"],
  [String.raw`/dev/tcp/\d|/dev/udp/\d`, "reverse_shell_devtcp", "critical", "Reverse shell via /dev/tcp or /dev/udp (SS09)"],
  [String.raw`\b(?:nc|ncat|netcat)\s+-[eElL]\b|\b(?:nc|ncat|netcat)\s+\S+\s+\d+\s+-[eEcC]\b|-[eElL]\s+\S+\s+\b(?:nc|ncat|netcat)\b`, "reverse_shell_netcat", "critical", "Reverse shell via netcat -e/-l (SS09)"],
  [String.raw`socat\s+[^;|]*(?:EXEC|exec).*TCP`, "reverse_shell_socat", "critical", "Reverse shell via socat (SS09)"],
  [String.raw`bash\s+-[iI]\s*>&?\s*/dev/tcp`, "reverse_shell_bash", "critical", "Bash reverse shell (SS09)"],
  [String.raw`(?:open|launch)\s+(?:a\s+)?terminal\s+and\s+(?:paste|run|type|execute)`, "clickfix_terminal", "high", "ClickFix: instruction to open terminal and run command (SS11)"],
  [String.raw`(?:copy|paste)\s+(?:this\s+)?(?:command|code|script)\s+(?:into|to)\s+(?:your\s+)?(?:terminal|console|command\s+prompt)`, "clickfix_copy_paste", "high", "ClickFix: copy-paste terminal instruction (SS11)"],
  [String.raw`press\s+(?:win|windows|cmd)\s*\+\s*r\s+and`, "clickfix_run_dialog", "high", "ClickFix: Windows Run dialog social engineering (SS11)"],
  [String.raw`\brm\s+(?:-[rRfv]+\s+)*(?:/(?:\s*$|[*\s;|&])|~(?:\s*$|[/\s;|&])|\$HOME(?:\s*$|[/\s;|&*]))`, "dangerous_rm_root", "critical", "Dangerous rm targeting root or home directory (SS13)"],
  [String.raw`\bdd\s+.*\bof=/dev/(?:sd[a-z]|hd[a-z]|nvme\d|xvd[a-z]|vd[a-z])`, "dangerous_dd_device", "critical", "dd writing to block device (SS13)"],
  [String.raw`\bnmap\b|\bmasscan\b|\barp-scan\b|\bzmap\b|\bunicornscan\b`, "recon_portscan", "high", "Network port scanning tool detected (SS14)"],
  [String.raw`169\.254\.169\.254`, "cloud_metadata_imds", "critical", "AWS/Azure/GCP instance metadata service endpoint (SS14)"],
  [String.raw`metadata\.google\.internal`, "cloud_metadata_gcp", "critical", "GCP metadata server access (SS14)"],
  [String.raw`100\.100\.100\.200`, "cloud_metadata_alibaba", "high", "Alibaba Cloud metadata endpoint (SS14)"],
  [String.raw`(?:cat|read|open)\s+.*~?(?:/home/[^/]+)?/\.aws/credentials`, "cred_read_aws", "critical", "Reading AWS credentials file (SS17)"],
  [String.raw`(?:cat|read|open)\s+.*~?(?:/home/[^/]+)?/\.docker/config\.json`, "cred_read_docker", "critical", "Reading Docker config (SS17)"],
  [String.raw`find\s+.*(?:\.ssh|\.aws|\.gnupg|\.config/gcloud)\s`, "cred_find_dirs", "high", "Searching credential directories (SS17)"],
  [String.raw`(?:seed\s+phrase|mnemonic\s+phrase|secret\s+recovery\s+phrase|wallet\s+recovery\s+phrase)`, "crypto_seed_phrase", "critical", "Cryptocurrency seed/recovery phrase reference (SS18)"],
  [String.raw`(?:MetaMask|Phantom|Exodus|Electrum|Wasabi|Trezor|Ledger)\s+(?:wallet|keystore|password|seed|mnemon)`, "crypto_wallet_software", "high", "Cryptocurrency wallet credential reference (SS18)"],
  [String.raw`~/\.(?:ethereum|bitcoin|litecoin|monero|dogecoin)|~/Library/(?:Ethereum|Bitcoin)`, "crypto_wallet_dir", "high", "Cryptocurrency wallet directory access (SS18)"],
  [String.raw`(?:\.\.\/){2,}(?:etc|usr|root|home|sys|proc|var)`, "path_traversal_sys", "high", "Directory traversal to system path (SS19)"],
  [String.raw`(?:cat|head|tail)\s+/etc/(?:passwd|shadow|sudoers|hosts)`, "sensitive_sys_read", "critical", "Reading sensitive system file (SS20)"],
  [String.raw`\.git/hooks/(?:pre-commit|post-commit|post-merge|pre-push|post-receive)\b`, "git_hook_persist", "medium", "Git hook file reference (SS20)"],
  [String.raw`\|\s*base64\s+(?:-d|--decode)\s*\|\s*(?:bash|sh|python3?|perl|ruby)\b`, "b64_decode_exec", "critical", "base64 decoded content piped to shell (SS05)"],
  [String.raw`base64\s+(?:-d|--decode)\s+[a-zA-Z0-9._-]+\s*\|\s*(?:bash|sh)\b`, "b64_file_exec", "critical", "base64 decoded file executed as shell (SS05)"],
];

// Pass 8: Unicode obfuscation
const OBFUSCATION_PATTERNS: PatternDef[] = [
  ["\u200b|\u200c|\u200d|\u2060|\ufeff", "unicode_zero_width", "high", "Zero-width Unicode character detected (SS10)"],
  ["[\u0430-\u044f\u0410-\u042f\u0451\u0401][a-zA-Z]|[a-zA-Z][\u0430-\u044f\u0410-\u042f\u0451\u0401]", "unicode_cyrillic_mix", "high", "Cyrillic characters mixed with Latin (SS10)"],
];

// ---------------------------------------------------------------------------
// Compiled pattern cache
// ---------------------------------------------------------------------------

interface CompiledPatterns {
  py: Array<[RegExp, string, RawFinding["severity"], string]>;
  js: Array<[RegExp, string, RawFinding["severity"], string]>;
  secrets: Array<[RegExp, string, RawFinding["severity"], string]>;
  secretPaths: Array<[RegExp, string, RawFinding["severity"], string]>;
  injection: Array<[RegExp, string, RawFinding["severity"], string]>;
  shellThreats: Array<[RegExp, string, RawFinding["severity"], string]>;
  obfuscation: Array<[RegExp, string, RawFinding["severity"], string]>;
  b64Blob: RegExp;
  b64Danger: RegExp;
  sectionHeader: RegExp;
  execRef: RegExp;
  urgency: RegExp;
  capNet: RegExp;
  capEnv: RegExp;
  capExec: RegExp;
  capWrite: RegExp;
  bomUrl: RegExp;
  bomOpen: RegExp;
  bomEnv: RegExp;
  bomImport: RegExp;
  bomJsRequire: RegExp;
  bomBinary: RegExp;
  bomFsDelete: RegExp;
  bomFsWrite: RegExp;
}

let _compiled: CompiledPatterns | null = null;

function compile(patterns: PatternDef[], flags?: string): Array<[RegExp, string, RawFinding["severity"], string]> {
  return patterns.map(([p, id, sev, msg]) => [new RegExp(p, flags), id, sev, msg]);
}

function getPatterns(): CompiledPatterns {
  if (_compiled) return _compiled;

  const KNOWN_BINARIES = [
    "git", "docker", "ffmpeg", "npm", "npx", "pip", "pip3", "cargo",
    "make", "cmake", "gcc", "g\\+\\+", "clang", "rustc", "go", "java",
    "javac", "ruby", "perl", "php", "wget", "curl", "ssh", "scp",
    "rsync", "tar", "zip", "unzip", "gzip", "7z", "jq", "yq",
    "kubectl", "helm", "terraform", "ansible", "vagrant", "brew",
    "apt", "apt-get", "yum", "dnf", "pacman", "snap", "flatpak",
  ];

  _compiled = {
    py: compile(PY_PATTERNS),
    js: compile(JS_PATTERNS),
    secrets: compile(SECRET_PATTERNS),
    secretPaths: compile(SECRET_PATH_PATTERNS),
    injection: compile(INJECTION_PATTERNS, "i"),
    shellThreats: compile(SHELL_THREAT_PATTERNS, "i"),
    obfuscation: compile(OBFUSCATION_PATTERNS, "u"),
    b64Blob: /[A-Za-z0-9+/]{40,}={0,2}/g,
    b64Danger: /curl[^;|]*\|\s*(?:bash|sh)\b|\/dev\/tcp\/|\brm\s+-[rRf]+\s+\/|wget[^;|]*\|\s*(?:bash|sh)\b|python\s+-c\s+["']import\s+socket|nc\s+.*-[eElL]/i,
    sectionHeader: /^#{1,4}\s+(?:prerequisites?|environment\s+setup|getting\s+started|initial\s+(?:configuration|setup)|first\s+run|quick\s+start|initialization|bootstrap|setup\s+steps?|pre-?install)\s*$/i,
    execRef: /(?:\bpython[23]?\s+\S+\.py\b|\bbash\s+\S+\.sh\b|\bsh\s+\S+\.sh\b|\bsource\s+\S+\.sh\b|`[^`]*\.\/[^`]*\.(?:sh|py|bash)[^`]*`|\.\/\S+\.(?:sh|py|bash)\b|\brun\s+\S+\.(?:sh|py|bash)\b|\bexecute\s+\S+\.(?:sh|py|bash)\b)/i,
    urgency: /(?:^>\s*(?:\*\*)?(?:IMPORTANT|WARNING|CRITICAL|CAUTION|NOTICE|REQUIRED)(?:\*\*)?|\*\*(?:IMPORTANT|WARNING|CRITICAL|CAUTION|REQUIRED)\*\*)/i,
    capNet: /(?:https?:\/\/[^\s'"]{2,}|urllib\.|requests\.\w|http\.client\b|\bcurl\s+https?:\/\/|\bwget\s+https?:\/\/|socket\.connect\b|urlopen\b)/i,
    capEnv: /(?:os\.environ\b|os\.getenv\s*\(|process\.env\b|\bgetenv\s*\()/i,
    capExec: /(?:subprocess\.\w+\s*\(|os\.system\s*\(|os\.popen\s*\(|\bexecSync\s*\(|\bspawnSync\s*\(|\bexecFileSync\s*\(|\bnew\s+Function\s*\(|\beval\s*\()/i,
    capWrite: /(?:open\s*\([^)]{0,120}['"]\s*[wa]\s*['"]|\.write\s*\(|\bshutil\.copy\b|\bshutil\.move\b|fs\.write(?:File)?\s*\(|fs\.append(?:File)?\s*\()/i,
    bomUrl: /https?:\/\/[^\s'")\]>]+/g,
    bomOpen: /open\s*\(\s*(['"])(.*?)\1(?:\s*,\s*(['"])(.*?)\3)?/g,
    bomEnv: /(?:os\.getenv\s*\(\s*['"](\w+)['"]|os\.environ(?:\[|\.get\s*\(\s*)['"](\w+)['"]|process\.env\.(\w+))/g,
    bomImport: /^\s*(?:import\s+([\w.]+)|from\s+([\w.]+)\s+import)/gm,
    bomJsRequire: /(?:require\s*\(\s*['"]([\w@/.-]+)['"]|import\s+.*?\bfrom\s+['"]([\w@/.-]+)['"])/g,
    bomBinary: new RegExp(`(?:^|[;\\s|&\`$()])(${KNOWN_BINARIES.join("|")})\\b`),
    bomFsDelete: /(?:os\.remove\s*\(|os\.unlink\s*\(|shutil\.rmtree\s*\(|fs\.unlinkSync\s*\(|fs\.rmdirSync\s*\(|fs\.rmSync\s*\(|\brm\s+-[rRf])/i,
    bomFsWrite: /(?:fs\.(?:writeFileSync|writeFile|appendFileSync|appendFile)\s*\(\s*['"]([^'"]+)['"]|(?:echo|cat|printf)\s+.*>\s*([a-zA-Z][\w./\-]*))/i,
  };
  return _compiled;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function ext(path: string): string {
  const i = path.lastIndexOf(".");
  return i >= 0 ? path.slice(i).toLowerCase() : "";
}

function isTextFile(path: string): boolean {
  return TEXT_EXTENSIONS.has(ext(path));
}

// ---------------------------------------------------------------------------
// Scan passes
// ---------------------------------------------------------------------------

function scanRegexPass(
  files: FileEntry[],
  patterns: Array<[RegExp, string, RawFinding["severity"], string]>,
  filterFn: (path: string) => boolean,
): RawFinding[] {
  const findings: RawFinding[] = [];
  for (const file of files) {
    if (!filterFn(file.path)) continue;
    const lines = file.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      for (const [re, ruleId, severity, message] of patterns) {
        // Reset lastIndex for global regexes
        re.lastIndex = 0;
        if (re.test(lines[i])) {
          findings.push({
            rule_id: ruleId,
            severity,
            file: file.path,
            line: i + 1,
            message,
            context: lines[i].trim().slice(0, 120),
          });
        }
      }
    }
  }
  return findings;
}

// Pass 6: Binary file detection
function scanBinaryFiles(files: FileEntry[]): RawFinding[] {
  const findings: RawFinding[] = [];
  for (const file of files) {
    if (BINARY_EXTENSIONS.has(ext(file.path))) {
      findings.push({
        rule_id: "binary_file",
        severity: "medium",
        file: file.path,
        line: 0,
        message: `Binary file detected: ${ext(file.path)}`,
      });
    }
  }
  return findings;
}

// Pass 7: base64 deep-scan
function scanBase64Deep(files: FileEntry[]): RawFinding[] {
  const p = getPatterns();
  const findings: RawFinding[] = [];
  for (const file of files) {
    if (!isTextFile(file.path)) continue;
    const lines = file.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      p.b64Blob.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = p.b64Blob.exec(lines[i])) !== null) {
        try {
          const decoded = atob(match[0]);
          p.b64Danger.lastIndex = 0;
          if (p.b64Danger.test(decoded)) {
            findings.push({
              rule_id: "b64_hidden_payload",
              severity: "critical",
              file: file.path,
              line: i + 1,
              message: "base64-encoded blob contains dangerous payload",
              context: decoded.slice(0, 120),
            });
          }
        } catch {
          // Not valid base64
        }
      }
    }
  }
  return findings;
}

// Pass 9: Structural mimicry
function scanStructuralMimicry(files: FileEntry[]): RawFinding[] {
  const p = getPatterns();
  const findings: RawFinding[] = [];
  const SECTION_LOOKAHEAD = 10;
  const URGENCY_LOOKAHEAD = 3;

  for (const file of files) {
    if (ext(file.path) !== ".md") continue;
    const lines = file.content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      // SM01: suspicious section header + script exec within lookahead
      if (p.sectionHeader.test(lines[i].trim())) {
        for (let j = i + 1; j < Math.min(i + SECTION_LOOKAHEAD + 1, lines.length); j++) {
          if (p.execRef.test(lines[j])) {
            findings.push({
              rule_id: "structural_mimicry_section",
              severity: "high",
              file: file.path,
              line: j + 1,
              message: `Structural mimicry: script execution inside '${lines[i].trim().slice(0, 60)}' section (SS-SM01)`,
              context: lines[j].trim().slice(0, 120),
            });
            break;
          }
        }
      }

      // SM02: urgency marker + script exec within lookahead
      if (p.urgency.test(lines[i])) {
        for (let j = i; j < Math.min(i + URGENCY_LOOKAHEAD + 1, lines.length); j++) {
          if (p.execRef.test(lines[j])) {
            findings.push({
              rule_id: "structural_mimicry_urgency",
              severity: "high",
              file: file.path,
              line: j + 1,
              message: "Structural mimicry: urgency framing adjacent to bundled script execution (SS-SM02)",
              context: lines[j].trim().slice(0, 120),
            });
            break;
          }
        }
      }
    }
  }
  return findings;
}

// Pass 10: Composite capability co-occurrence
function scanComposite(files: FileEntry[], priorFindings: RawFinding[]): RawFinding[] {
  const p = getPatterns();
  const findings: RawFinding[] = [];

  for (const file of files) {
    if (!SCRIPT_EXTENSIONS.has(ext(file.path))) continue;
    const content = file.content;

    const hasExec = p.capExec.test(content);
    const hasNetwork = p.capNet.test(content);
    const hasEnv = p.capEnv.test(content);
    const hasWrite = p.capWrite.test(content);

    if (hasExec && hasNetwork) {
      findings.push({
        rule_id: "composite_exec_exfil",
        severity: "critical",
        file: file.path,
        line: 0,
        message: "Composite: process execution + outbound network in same file (SS-CP01)",
      });
    }

    if (hasEnv && hasNetwork && !hasExec) {
      findings.push({
        rule_id: "composite_env_leak",
        severity: "high",
        file: file.path,
        line: 0,
        message: "Composite: environment variable read + outbound network (SS-CP02)",
      });
    }

    if (hasWrite && hasNetwork && !hasExec && !hasEnv) {
      findings.push({
        rule_id: "composite_write_exfil",
        severity: "high",
        file: file.path,
        line: 0,
        message: "Composite: file write + outbound network in same file (SS-CP03)",
      });
    }
  }

  // CP04: 3+ medium-or-higher findings in one file (excludes info-level capability findings)
  const mediumCounts: Record<string, { count: number; rules: Set<string> }> = {};
  for (const f of priorFindings) {
    if (f.severity === "medium" || f.severity === "high") {
      if (!mediumCounts[f.file]) mediumCounts[f.file] = { count: 0, rules: new Set() };
      mediumCounts[f.file].count++;
      mediumCounts[f.file].rules.add(f.rule_id);
    }
  }
  for (const [file, { count, rules }] of Object.entries(mediumCounts)) {
    if (count >= 3) {
      findings.push({
        rule_id: "composite_medium_cluster",
        severity: "high",
        file,
        line: 0,
        message: `Composite: ${count} medium-severity findings in one file (SS-CP04)`,
        context: [...rules].sort().join(", ").slice(0, 120),
      });
    }
  }

  return findings;
}

// Pass 11: Surplus functionality
function scanSurplusFunctionality(files: FileEntry[]): RawFinding[] {
  const p = getPatterns();
  const findings: RawFinding[] = [];

  // Find SKILL.md
  const skillDoc = files.find(f => f.path.toLowerCase() === "skill.md")
    || files.find(f => f.path.toLowerCase().endsWith("/skill.md"));
  if (!skillDoc) return findings;

  const docText = skillDoc.content.toLowerCase();

  const DOC_NETWORK = ["network", "http", "https", "api", "request", "download", "upload", "fetch", "send", "post", "webhook", "url", "endpoint", "connect", "internet", "remote", "server", "client", "web"];
  const DOC_ENV = ["environment", "env var", "env_var", "credential", "api key", "api_key", "token", "secret", "config", "variable", "getenv", "environ"];
  const DOC_SUBPROCESS = ["execute", "shell", "command", "spawn", "subprocess", "terminal", "cli", "invoke", "launch", "process", "exec"];
  const DOC_FILE_WRITE = ["write", "output", "save", "generate", "export", "report"];

  const docHasNetwork = DOC_NETWORK.some(kw => docText.includes(kw));
  const docHasEnv = DOC_ENV.some(kw => docText.includes(kw));
  const docHasSubprocess = DOC_SUBPROCESS.some(kw => docText.includes(kw));
  const docHasFileWrite = DOC_FILE_WRITE.some(kw => docText.includes(kw));

  for (const file of files) {
    if (!SCRIPT_EXTENSIONS.has(ext(file.path))) continue;
    if (file.path === skillDoc.path) continue;

    if (p.capNet.test(file.content) && !docHasNetwork) {
      findings.push({ rule_id: "undoc_network", severity: "critical", file: file.path, line: 0, message: "Surplus: script makes outbound network calls not documented in SKILL.md (SS-SF01)" });
    }
    if (p.capEnv.test(file.content) && !docHasEnv) {
      findings.push({ rule_id: "undoc_env_read", severity: "high", file: file.path, line: 0, message: "Surplus: script reads environment variables not documented in SKILL.md (SS-SF02)" });
    }
    if (p.capExec.test(file.content) && !docHasSubprocess) {
      findings.push({ rule_id: "undoc_subprocess", severity: "high", file: file.path, line: 0, message: "Surplus: script executes subprocesses not documented in SKILL.md (SS-SF03)" });
    }
    if (p.capWrite.test(file.content) && !docHasFileWrite) {
      findings.push({ rule_id: "undoc_file_write", severity: "medium", file: file.path, line: 0, message: "Surplus: script writes files not documented in SKILL.md (SS-SF04)" });
    }
  }

  return findings;
}

// Pass 12: BOM generation
function generateBom(files: FileEntry[]): BomReport {
  const p = getPatterns();
  const fileReads: BomEntry[] = [];
  const fileWrites: BomEntry[] = [];
  const fileDeletes: BomEntry[] = [];
  const urlsList: BomEntry[] = [];
  const envVars: BomEntry[] = [];
  const binaries: BomEntry[] = [];
  const systemCommands: BomEntry[] = [];
  const pyImports = new Set<string>();
  const jsRequires = new Set<string>();
  const shellTools = new Set<string>();
  const filesWithCaps = new Set<string>();

  for (const file of files) {
    if (!isTextFile(file.path)) continue;
    const lines = file.content.split("\n");
    let hasCap = false;
    const isPy = ext(file.path) === ".py";
    const isJs = JS_EXTENSIONS.has(ext(file.path));

    for (let lineNo = 0; lineNo < lines.length; lineNo++) {
      const line = lines[lineNo];

      // URLs
      p.bomUrl.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = p.bomUrl.exec(line)) !== null) {
        urlsList.push({ file: file.path, line: lineNo + 1, url: m[0].replace(/[.,;:)]+$/, "") });
        hasCap = true;
      }

      // open() calls
      p.bomOpen.lastIndex = 0;
      while ((m = p.bomOpen.exec(line)) !== null) {
        const target = m[2];
        const mode = m[4] || "r";
        const entry: BomEntry = { file: file.path, line: lineNo + 1, pattern: line.trim().slice(0, 120), target };
        if (/[wax]/.test(mode)) {
          fileWrites.push(entry);
        } else {
          fileReads.push(entry);
        }
        hasCap = true;
      }

      // Env vars
      p.bomEnv.lastIndex = 0;
      while ((m = p.bomEnv.exec(line)) !== null) {
        const name = m[1] || m[2] || m[3];
        if (name) {
          envVars.push({ file: file.path, line: lineNo + 1, name, usage: line.trim().slice(0, 120) });
          hasCap = true;
        }
      }

      // Binaries
      if (p.bomBinary.test(line)) {
        const bm = p.bomBinary.exec(line);
        if (bm) {
          binaries.push({ file: file.path, line: lineNo + 1, name: bm[1], context: line.trim().slice(0, 120) });
          shellTools.add(bm[1]);
          hasCap = true;
        }
      }

      // File deletes
      if (p.bomFsDelete.test(line)) {
        fileDeletes.push({ file: file.path, line: lineNo + 1, pattern: line.trim().slice(0, 120) });
        hasCap = true;
      }

      // File writes (non-open patterns)
      const fwm = p.bomFsWrite.exec(line);
      if (fwm) {
        const target = fwm[1] || fwm[2] || "";
        fileWrites.push({ file: file.path, line: lineNo + 1, pattern: line.trim().slice(0, 120), target });
        hasCap = true;
      }

      // System commands
      if (p.capExec.test(line)) {
        systemCommands.push({ file: file.path, line: lineNo + 1, command: line.trim().slice(0, 120) });
        hasCap = true;
      }
    }

    // Python imports
    if (isPy) {
      p.bomImport.lastIndex = 0;
      let im: RegExpExecArray | null;
      while ((im = p.bomImport.exec(file.content)) !== null) {
        const mod = im[1] || im[2];
        if (mod) pyImports.add(mod.split(".")[0]);
      }
    }

    // JS requires/imports
    if (isJs) {
      p.bomJsRequire.lastIndex = 0;
      let jm: RegExpExecArray | null;
      while ((jm = p.bomJsRequire.exec(file.content)) !== null) {
        const mod = jm[1] || jm[2];
        if (mod) jsRequires.add(mod.startsWith("@") ? mod.split("/")[0].slice(1) : mod);
      }
    }

    if (hasCap) filesWithCaps.add(file.path);
  }

  // Deduplicate URLs, extract domains/protocols
  const seenUrls = new Set<string>();
  const uniqueUrls: BomEntry[] = [];
  const allDomains = new Set<string>();
  const allProtocols = new Set<string>();
  for (const u of urlsList) {
    const urlVal = u.url as string;
    if (!seenUrls.has(urlVal)) {
      seenUrls.add(urlVal);
      uniqueUrls.push(u);
    }
    try {
      const parsed = new URL(urlVal);
      if (parsed.hostname) allDomains.add(parsed.hostname);
      if (parsed.protocol) allProtocols.add(parsed.protocol.replace(":", ""));
    } catch { /* ignore invalid URLs */ }
  }

  // Capabilities
  const capUsed: string[] = [];
  const capCounts: Record<string, number> = {};
  if (uniqueUrls.length) { capUsed.push("network_access"); capCounts.network = uniqueUrls.length; }
  if (fileReads.length || fileWrites.length || fileDeletes.length) { capUsed.push("file_access"); capCounts.file_access = fileReads.length + fileWrites.length + fileDeletes.length; }
  if (envVars.length) { capUsed.push("env_read"); capCounts.env_read = envVars.length; }
  if (systemCommands.length) { capUsed.push("subprocess_exec"); capCounts.subprocess = systemCommands.length; }
  if (fileWrites.length) capUsed.push("file_write");

  const nCaps = capUsed.length;
  const risk = nCaps === 0 ? "none" : nCaps === 1 ? "low" : nCaps <= 3 ? "medium" : "high";

  // Data flow
  const inputs: Array<{ type: string; name?: string; path?: string }> = [];
  const seenInputs = new Set<string>();
  for (const ev of envVars) {
    const key = `env_var:${ev.name}`;
    if (!seenInputs.has(key)) { seenInputs.add(key); inputs.push({ type: "env_var", name: ev.name as string }); }
  }
  for (const fr of fileReads) {
    const t = fr.target as string;
    const key = `file_read:${t}`;
    if (t && !seenInputs.has(key)) { seenInputs.add(key); inputs.push({ type: "file_read", path: t }); }
  }

  const outputs: Array<{ type: string; path?: string; domain?: string }> = [];
  const seenOutputs = new Set<string>();
  for (const fw of fileWrites) {
    const t = fw.target as string;
    if (t && !seenOutputs.has(`file_write:${t}`)) { seenOutputs.add(`file_write:${t}`); outputs.push({ type: "file_write", path: t }); }
  }
  for (const d of [...allDomains].sort()) {
    outputs.push({ type: "network", domain: d });
  }

  return {
    schema_version: "1.0",
    file_access: { reads: fileReads, writes: fileWrites, deletes: fileDeletes, creates: [] },
    network: { urls: uniqueUrls, domains: [...allDomains].sort(), protocols: [...allProtocols].sort() },
    environment: { env_vars: envVars, binaries, system_commands: systemCommands },
    permissions: { capabilities_used: capUsed, risk_surface: risk },
    data_flow: { inputs, outputs },
    dependencies: { python_imports: [...pyImports].sort(), js_requires: [...jsRequires].sort(), shell_tools: [...shellTools].sort() },
    summary: {
      total_files_scanned: files.length,
      files_with_capabilities: filesWithCaps.size,
      capability_count: capCounts,
      risk_surface: risk,
    },
  };
}

// ---------------------------------------------------------------------------
// Post-filters: reduce false positives for rules with known FP patterns
// ---------------------------------------------------------------------------

/** rm targeting app-specific dotfile paths (e.g. rm -f ~/.gstack/file) is not dangerous */
const RM_APP_CLEANUP = /\brm\s+(?:-[fv]+\s+)+~\/\.\w+\/\S+/;
/** Lines that are shell comments (leading #) or inside markdown code-comment context */
const COMMENT_LINE = /^\s*#(?!\s*!)/;

function postFilterFindings(findings: RawFinding[], files: FileEntry[]): RawFinding[] {
  // Build a line cache for efficient lookups
  const lineCache = new Map<string, string[]>();
  for (const f of files) {
    lineCache.set(f.path, f.content.split("\n"));
  }

  return findings.filter(f => {
    // --- dangerous_rm_root: skip targeted app-specific cleanup ---
    if (f.rule_id === "dangerous_rm_root") {
      const ctx = f.context || "";
      const lines = lineCache.get(f.file);
      const line = lines && f.line > 0 ? lines[f.line - 1] : ctx;
      // Skip if this is a comment line
      if (COMMENT_LINE.test(line)) return false;
      // Skip rm -f (no -r) targeting a specific dotfile path (2+ segments under ~/)
      if (RM_APP_CLEANUP.test(line) && !/\s-[^\s]*r/i.test(line)) return false;
    }

    // --- structural_mimicry: skip SKILL.md and README.md ---
    // These files *should* have setup sections with commands — that's their purpose.
    if (f.rule_id === "structural_mimicry_section" || f.rule_id === "structural_mimicry_urgency") {
      const basename = f.file.split("/").pop()?.toLowerCase() || "";
      if (basename === "skill.md" || basename === "readme.md") return false;
    }

    return true;
  });
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function scanFiles(files: FileEntry[]): ScanResult {
  const p = getPatterns();
  const allFindings: RawFinding[] = [];

  // Pass 1: Python dangerous calls (regex)
  allFindings.push(...scanRegexPass(files, p.py, path => ext(path) === ".py"));

  // Pass 2: JS/TS dangerous calls
  allFindings.push(...scanRegexPass(files, p.js, path => JS_EXTENSIONS.has(ext(path))));

  // Pass 3: Secret detection (all text files)
  allFindings.push(...scanRegexPass(files, p.secrets, isTextFile));

  // Pass 3b: Secret-bearing-path references (.env, ~/.aws, ~/.ssh, etc.)
  // — distinct from Pass 3 which finds actual key values. Lets the keychain
  // rewriter target paths separately from secret literals.
  allFindings.push(...scanRegexPass(files, p.secretPaths, isTextFile));

  // Pass 4: Prompt injection (text-like files only)
  allFindings.push(...scanRegexPass(files, p.injection, path => INJECTION_EXTENSIONS.has(ext(path))));

  // Pass 5: Shell/general threats (all text files)
  allFindings.push(...scanRegexPass(files, p.shellThreats, isTextFile));

  // Pass 6: Binary file detection
  allFindings.push(...scanBinaryFiles(files));

  // Pass 7: base64 deep-scan
  allFindings.push(...scanBase64Deep(files));

  // Pass 8: Unicode obfuscation
  allFindings.push(...scanRegexPass(files, p.obfuscation, isTextFile));

  // Pass 9: Structural mimicry (.md files)
  allFindings.push(...scanStructuralMimicry(files));

  // Pass 10: Composite capability co-occurrence
  allFindings.push(...scanComposite(files, allFindings));

  // Pass 11: Surplus functionality
  allFindings.push(...scanSurplusFunctionality(files));

  // Post-filter: reduce known FP patterns
  const filtered = postFilterFindings(allFindings, files);

  // Pass 12: BOM
  const bom = generateBom(files);

  return {
    schema_version: "2.0",
    scanner: {
      tool: SCANNER_TOOL,
      version: SCANNER_VERSION,
      ruleset_version: RULESET_VERSION,
    },
    raw_findings: filtered,
    bom,
    file_count: files.length,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Gitree hash computation (from GitHub tree API response, no file download)
// ---------------------------------------------------------------------------

export async function computeGitreeHash(
  entries: Array<{ path: string; sha: string }>,
): Promise<string> {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const manifest = sorted.map(e => `${e.path}\0${e.sha}\n`).join("");
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(manifest));
  const hex = [...new Uint8Array(hashBuffer)].map(b => b.toString(16).padStart(2, "0")).join("");
  return `gitree:${hex}`;
}
