"use client";

import dynamic from "next/dynamic";
import { useTheme } from "next-themes";
import { useMemo } from "react";

const MonacoEditor = dynamic(() => import("@monaco-editor/react").then((m) => m.default), {
  ssr: false,
  loading: () => <div className="flex h-full items-center justify-center text-xs text-muted-foreground">Loading Monaco…</div>,
});

type Props = {
  content: string;
  onChange: (next: string) => void;
  ext: string | null;
};

const LANG_BY_EXT: Record<string, string> = {
  ".js": "javascript",
  ".jsx": "javascript",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".sql": "sql",
  ".py": "python",
  ".sh": "shell",
  ".bash": "shell",
  ".css": "css",
  ".scss": "scss",
  ".html": "html",
  ".htm": "html",
  ".md": "markdown",
  ".xml": "xml",
  ".rb": "ruby",
  ".php": "php",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".c": "c",
  ".cpp": "cpp",
  ".h": "c",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".ini": "ini",
  ".toml": "ini",
  ".dockerfile": "dockerfile",
  ".env": "shell",
};

export function MonacoCodeEditor({ content, onChange, ext }: Props) {
  const { theme } = useTheme();
  const monacoTheme = theme === "dark" ? "vs-dark" : "light";

  const language = useMemo(() => (ext && LANG_BY_EXT[ext]) || "plaintext", [ext]);

  return (
    <div className="h-full w-full" onKeyDown={(e) => e.stopPropagation()}>
      <MonacoEditor
        height="100%"
        language={language}
        value={content}
        theme={monacoTheme}
        onChange={(v) => onChange(v ?? "")}
        options={{
          minimap: { enabled: true },
          fontSize: 13,
          wordWrap: "on",
          smoothScrolling: true,
          scrollBeyondLastLine: false,
          padding: { top: 12, bottom: 12 },
          renderWhitespace: "selection",
          tabSize: 2,
          formatOnPaste: true,
          formatOnType: false,
        }}
      />
    </div>
  );
}
