<?php
/**
 * token_audit.php
 *
 * Recursively scans for code files (php/js/html/css) and counts tokens using OpenAI's tiktoken
 * (via a small embedded Python helper).
 *
 * Requirements:
 *   - python3 available
 *   - python3 package: tiktoken (pip install tiktoken)
 *
 * Usage:
 *   php token_audit.php --root=/var/www/html/musclemap
 *
 * Optional:
 *   --encoding=cl100k_base   (default)
 *   --ext=php,js,html,css
 *   --ignore=node_modules,vendor,uploads,z-anatomy-unity,.git
 *   --top=50
 *   --json=1
 */

declare(strict_types=1);

main($argv);

function main(array $argv): void {
    $args = parseArgs($argv);

    $root = rtrim($args['root'] ?? getcwd(), "/");
    if (!is_dir($root)) {
        fwrite(STDERR, "ERROR: root is not a directory: {$root}\n");
        exit(2);
    }

    $encoding = (string)($args['encoding'] ?? "cl100k_base");
    $exts = parseCsvLower($args['ext'] ?? "php,js,html,css");
    $ignore = parseCsvLower($args['ignore'] ?? "node_modules,vendor,uploads,z-anatomy-unity,.git");
    $top = max(1, (int)($args['top'] ?? 50));
    $asJson = ((int)($args['json'] ?? 0) === 1);

    $files = collectFiles($root, $exts, $ignore);
    if (!$files) {
        fwrite(STDERR, "No matching files found.\n");
        exit(0);
    }

    // Build a Python helper file in /tmp
    $pyPath = sys_get_temp_dir() . "/tiktoken_count_" . getmypid() . ".py";
    file_put_contents($pyPath, pythonHelper());

    $rows = [];
    $totals = [
        'files' => 0,
        'bytes' => 0,
        'chars' => 0,
        'lines' => 0,
        'tokens' => 0,
    ];

    foreach ($files as $path) {
        $content = @file_get_contents($path);
        if ($content === false) {
            $rows[] = [
                'file' => relPath($root, $path),
                'bytes' => 0,
                'chars' => 0,
                'lines' => 0,
                'tokens' => 0,
                'error' => 'unreadable',
            ];
            continue;
        }

        $bytes = strlen($content);
        $chars = mb_strlen($content, 'UTF-8');
        $lines = substr_count($content, "\n") + (strlen($content) > 0 ? 1 : 0);

        // Count tokens by piping the file content to python helper stdin
        $tokens = tiktokenCount($pyPath, $encoding, $content);

        $rows[] = [
            'file' => relPath($root, $path),
            'bytes' => $bytes,
            'chars' => $chars,
            'lines' => $lines,
            'tokens' => $tokens,
        ];

        $totals['files']++;
        $totals['bytes'] += $bytes;
        $totals['chars'] += $chars;
        $totals['lines'] += $lines;
        $totals['tokens'] += $tokens;
    }

    // cleanup helper
    @unlink($pyPath);

    usort($rows, fn($a, $b) => ($b['tokens'] ?? 0) <=> ($a['tokens'] ?? 0));

    if ($asJson) {
        echo json_encode([
            'root' => $root,
            'encoding' => $encoding,
            'exts' => $exts,
            'ignore' => $ignore,
            'totals' => $totals,
            'files_sorted' => $rows,
        ], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n";
        return;
    }

    echo "Root: {$root}\n";
    echo "Encoding: {$encoding}\n";
    echo "Extensions: " . implode(",", $exts) . "\n";
    echo "Ignore: " . implode(",", $ignore) . "\n\n";

    echo "TOTALS\n";
    echo "  Files:  {$totals['files']}\n";
    echo "  Bytes:  {$totals['bytes']}\n";
    echo "  Chars:  {$totals['chars']}\n";
    echo "  Lines:  {$totals['lines']}\n";
    echo "  Tokens: {$totals['tokens']}\n\n";

    echo "TOP {$top} FILES BY TOKENS\n";
    echo str_pad("TOKENS", 10) . str_pad("LINES", 8) . "FILE\n";
    echo str_repeat("-", 90) . "\n";

    $shown = 0;
    foreach ($rows as $r) {
        if ($shown >= $top) break;
        $t = (string)($r['tokens'] ?? 0);
        $l = (string)($r['lines'] ?? 0);
        $file = $r['file'];
        echo str_pad($t, 10) . str_pad($l, 8) . $file;
        if (isset($r['error'])) echo "  [{$r['error']}]";
        echo "\n";
        $shown++;
    }
}

function pythonHelper(): string {
    // Reads stdin bytes, decodes as UTF-8 (replace errors), counts tokens using tiktoken encoding.
    return <<<'PY'
import sys
import tiktoken

def main():
    if len(sys.argv) < 2:
        print("0")
        return
    enc_name = sys.argv[1]
    data = sys.stdin.buffer.read()
    text = data.decode("utf-8", errors="replace")

    enc = tiktoken.get_encoding(enc_name)
    # Count tokens
    n = len(enc.encode(text))
    sys.stdout.write(str(n))

if __name__ == "__main__":
    main()
PY;
}

function tiktokenCount(string $pyPath, string $encoding, string $content): int {
    $python = "myenv/bin/python3";
    $cmd = escapeshellcmd($python) . " " . escapeshellarg($pyPath) . " " . escapeshellarg($encoding);


    $descriptors = [
        0 => ["pipe", "r"], // stdin
        1 => ["pipe", "w"], // stdout
        2 => ["pipe", "w"], // stderr
    ];

    $proc = proc_open($cmd, $descriptors, $pipes);
    if (!is_resource($proc)) {
        fwrite(STDERR, "ERROR: failed to start python3. Is it installed?\n");
        return 0;
    }

    fwrite($pipes[0], $content);
    fclose($pipes[0]);

    $out = stream_get_contents($pipes[1]);
    fclose($pipes[1]);

    $err = stream_get_contents($pipes[2]);
    fclose($pipes[2]);

    $code = proc_close($proc);

    if ($code !== 0) {
        // Typical cause: missing tiktoken
        fwrite(STDERR, "Python error (exit {$code}): {$err}\n");
        return 0;
    }

    $out = trim($out);
    return ctype_digit($out) ? (int)$out : 0;
}

/* ========================= Helpers ========================= */

function parseArgs(array $argv): array {
    $out = [];
    foreach ($argv as $i => $arg) {
        if ($i === 0) continue;
        if (strpos($arg, "--") !== 0) continue;
        $eq = strpos($arg, "=");
        if ($eq === false) {
            $key = substr($arg, 2);
            $out[$key] = "1";
        } else {
            $key = substr($arg, 2, $eq - 2);
            $val = substr($arg, $eq + 1);
            $out[$key] = $val;
        }
    }
    return $out;
}

function parseCsvLower(string $csv): array {
    $parts = array_filter(array_map('trim', explode(",", $csv)), fn($x) => $x !== "");
    $parts = array_map(fn($x) => strtolower($x), $parts);
    return array_values(array_unique($parts));
}

function collectFiles(string $root, array $exts, array $ignoreDirs): array {
    $result = [];

    $it = new RecursiveIteratorIterator(
        new RecursiveCallbackFilterIterator(
            new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS),
            function ($current) use ($ignoreDirs) {
                /** @var SplFileInfo $current */
                $name = $current->getFilename();

                if ($current->isDir()) {
                    if ($name === "." || $name === "..") return false;
                    // ignore hidden dirs + selected dirs
                    if ($name !== "" && $name[0] === ".") return false;
                    if (in_array(strtolower($name), $ignoreDirs, true)) return false;
                    return true;
                }
                return true;
            }
        ),
        RecursiveIteratorIterator::LEAVES_ONLY
    );

    foreach ($it as $fileInfo) {
        /** @var SplFileInfo $fileInfo */
        if (!$fileInfo->isFile()) continue;

        $path = $fileInfo->getPathname();
        $ext = strtolower(pathinfo($path, PATHINFO_EXTENSION));
        if (!in_array($ext, $exts, true)) continue;

        $result[] = $path;
    }

    sort($result);
    return $result;
}

function relPath(string $root, string $path): string {
    $root = rtrim($root, "/") . "/";
    if (strpos($path, $root) === 0) return substr($path, strlen($root));
    return $path;
}
