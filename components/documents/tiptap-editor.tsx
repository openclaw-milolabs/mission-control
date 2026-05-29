"use client";

import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Underline from "@tiptap/extension-underline";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { useEffect, useRef } from "react";
import {
  BoldIcon,
  ItalicIcon,
  UnderlineIcon,
  StrikethroughIcon,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  ListIcon,
  ListOrderedIcon,
  QuoteIcon,
  CodeIcon,
  CheckSquareIcon,
  LinkIcon as LinkLucide,
  Undo2Icon,
  Redo2Icon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Props = {
  content: string;
  onChange: (next: string) => void;
  ext: string | null;
};

const TOOL_BTN = "size-7 p-0 text-muted-foreground hover:text-foreground";

export function TiptapEditor({ content, onChange, ext }: Props) {
  const isHtml = ext === ".html" || ext === ".htm";
  const lastSyncedRef = useRef<string | null>(null);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        codeBlock: { HTMLAttributes: { class: "rounded-md bg-muted/40 p-3 text-xs font-mono" } },
        heading: { levels: [1, 2, 3] },
      }),
      Link.configure({ openOnClick: false, autolink: true, linkOnPaste: true, HTMLAttributes: { class: "text-primary underline" } }),
      Underline,
      TaskList,
      TaskItem.configure({ nested: true }),
    ],
    content: isHtml ? content : markdownLikeToHtml(content),
    onUpdate: ({ editor }) => {
      const html = editor.getHTML();
      const out = isHtml ? html : htmlToMarkdownLike(html);
      lastSyncedRef.current = out;
      onChange(out);
    },
    editorProps: {
      attributes: {
        class: "prose prose-sm max-w-none dark:prose-invert focus:outline-none p-6 min-h-full",
      },
    },
    immediatelyRender: false,
  });

  // External content updates (e.g. switching docs) — only push if different
  // from what we last emitted, to avoid clobbering in-flight user typing.
  useEffect(() => {
    if (!editor) return;
    if (content === lastSyncedRef.current) return;
    const next = isHtml ? content : markdownLikeToHtml(content);
    if (editor.getHTML() === next) return;
    editor.commands.setContent(next, false);
    lastSyncedRef.current = content;
  }, [content, editor, isHtml]);

  if (!editor) {
    return <div className="flex h-full items-center justify-center text-xs text-muted-foreground">Loading…</div>;
  }

  const tool = (active: boolean, onClick: () => void, Icon: typeof BoldIcon, label: string) => (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(TOOL_BTN, active && "bg-accent text-foreground")}
    >
      <Icon className="size-3.5" />
    </Button>
  );

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-0.5 border-b bg-muted/20 px-2 py-1.5">
        {tool(editor.isActive("bold"), () => editor.chain().focus().toggleBold().run(), BoldIcon, "Bold")}
        {tool(editor.isActive("italic"), () => editor.chain().focus().toggleItalic().run(), ItalicIcon, "Italic")}
        {tool(editor.isActive("underline"), () => editor.chain().focus().toggleUnderline().run(), UnderlineIcon, "Underline")}
        {tool(editor.isActive("strike"), () => editor.chain().focus().toggleStrike().run(), StrikethroughIcon, "Strikethrough")}
        <span className="mx-1 h-4 w-px bg-border" />
        {tool(editor.isActive("heading", { level: 1 }), () => editor.chain().focus().toggleHeading({ level: 1 }).run(), Heading1Icon, "Heading 1")}
        {tool(editor.isActive("heading", { level: 2 }), () => editor.chain().focus().toggleHeading({ level: 2 }).run(), Heading2Icon, "Heading 2")}
        {tool(editor.isActive("heading", { level: 3 }), () => editor.chain().focus().toggleHeading({ level: 3 }).run(), Heading3Icon, "Heading 3")}
        <span className="mx-1 h-4 w-px bg-border" />
        {tool(editor.isActive("bulletList"), () => editor.chain().focus().toggleBulletList().run(), ListIcon, "Bullet list")}
        {tool(editor.isActive("orderedList"), () => editor.chain().focus().toggleOrderedList().run(), ListOrderedIcon, "Numbered list")}
        {tool(editor.isActive("taskList"), () => editor.chain().focus().toggleTaskList().run(), CheckSquareIcon, "Task list")}
        <span className="mx-1 h-4 w-px bg-border" />
        {tool(editor.isActive("blockquote"), () => editor.chain().focus().toggleBlockquote().run(), QuoteIcon, "Quote")}
        {tool(editor.isActive("codeBlock"), () => editor.chain().focus().toggleCodeBlock().run(), CodeIcon, "Code block")}
        {tool(editor.isActive("link"), () => {
          const url = window.prompt("Link URL");
          if (url) editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
          else if (editor.isActive("link")) editor.chain().focus().unsetLink().run();
        }, LinkLucide, "Link")}
        <span className="mx-1 h-4 w-px bg-border" />
        {tool(false, () => editor.chain().focus().undo().run(), Undo2Icon, "Undo")}
        {tool(false, () => editor.chain().focus().redo().run(), Redo2Icon, "Redo")}
        <span className="ml-auto text-[10px] text-muted-foreground/70">
          {isHtml ? "HTML mode" : "Rich text"}
        </span>
      </div>

      {/* Editor surface */}
      <div className="flex-1 min-h-0 overflow-auto bg-background">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}

// Very lightweight markdown-ish ⇄ HTML conversion.
// Good enough for plain notes; not a full markdown parser. For files where the
// user wants full fidelity (.md with complex syntax), the Edit-as-source escape
// hatch is to rename the file to a non-markdown extension and use Monaco.

function markdownLikeToHtml(md: string): string {
  if (!md) return "";
  const escaped = md
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  // Already-HTML detection: if the input looks like HTML, trust it.
  if (/^\s*<(p|h\d|ul|ol|blockquote|pre|div)\b/i.test(md.trim())) return md;
  // Process line by line.
  const lines = escaped.split(/\r?\n/);
  const out: string[] = [];
  let inList: "ul" | "ol" | null = null;
  let inCode = false;
  for (const line of lines) {
    if (line.startsWith("```")) {
      if (inCode) { out.push("</code></pre>"); inCode = false; }
      else { out.push('<pre><code>'); inCode = true; }
      continue;
    }
    if (inCode) { out.push(line); continue; }
    if (/^#{1}\s+/.test(line)) { closeList(out, inList); inList = null; out.push(`<h1>${inlineMd(line.replace(/^#\s+/, ""))}</h1>`); continue; }
    if (/^#{2}\s+/.test(line)) { closeList(out, inList); inList = null; out.push(`<h2>${inlineMd(line.replace(/^##\s+/, ""))}</h2>`); continue; }
    if (/^#{3}\s+/.test(line)) { closeList(out, inList); inList = null; out.push(`<h3>${inlineMd(line.replace(/^###\s+/, ""))}</h3>`); continue; }
    if (/^>\s+/.test(line)) { closeList(out, inList); inList = null; out.push(`<blockquote><p>${inlineMd(line.replace(/^>\s+/, ""))}</p></blockquote>`); continue; }
    if (/^[-*]\s+/.test(line)) {
      if (inList !== "ul") { closeList(out, inList); out.push("<ul>"); inList = "ul"; }
      out.push(`<li>${inlineMd(line.replace(/^[-*]\s+/, ""))}</li>`);
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      if (inList !== "ol") { closeList(out, inList); out.push("<ol>"); inList = "ol"; }
      out.push(`<li>${inlineMd(line.replace(/^\d+\.\s+/, ""))}</li>`);
      continue;
    }
    if (!line.trim()) { closeList(out, inList); inList = null; continue; }
    closeList(out, inList); inList = null;
    out.push(`<p>${inlineMd(line)}</p>`);
  }
  closeList(out, inList);
  if (inCode) out.push("</code></pre>");
  return out.join("\n");
}

function closeList(out: string[], inList: "ul" | "ol" | null) {
  if (inList === "ul") out.push("</ul>");
  if (inList === "ol") out.push("</ol>");
}

function inlineMd(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

function htmlToMarkdownLike(html: string): string {
  if (!html) return "";
  // Very loose HTML → md conversion. Keeps existing HTML intact for things we
  // don't know how to convert.
  let out = html
    .replace(/<p>([\s\S]*?)<\/p>/g, "$1\n")
    .replace(/<h1>([\s\S]*?)<\/h1>/gi, "# $1\n")
    .replace(/<h2>([\s\S]*?)<\/h2>/gi, "## $1\n")
    .replace(/<h3>([\s\S]*?)<\/h3>/gi, "### $1\n")
    .replace(/<strong>([\s\S]*?)<\/strong>/gi, "**$1**")
    .replace(/<b>([\s\S]*?)<\/b>/gi, "**$1**")
    .replace(/<em>([\s\S]*?)<\/em>/gi, "*$1*")
    .replace(/<i>([\s\S]*?)<\/i>/gi, "*$1*")
    .replace(/<code>([\s\S]*?)<\/code>/gi, "`$1`")
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
    .replace(/<blockquote>\s*<p>([\s\S]*?)<\/p>\s*<\/blockquote>/g, "> $1\n")
    .replace(/<ul>([\s\S]*?)<\/ul>/gi, (_m, inner) => String(inner).replace(/<li>([\s\S]*?)<\/li>/g, "- $1\n"))
    .replace(/<ol>([\s\S]*?)<\/ol>/gi, (_m, inner) => {
      let n = 1;
      return String(inner).replace(/<li>([\s\S]*?)<\/li>/g, () => `${n++}. $1\n`);
    })
    .replace(/<pre><code>([\s\S]*?)<\/code><\/pre>/gi, "```\n$1\n```\n")
    .replace(/<br\s*\/?>/gi, "\n");
  // Strip remaining tags we don't recognise.
  out = out.replace(/<\/?[^>]+>/g, "");
  // Decode the few entities we added when going to HTML.
  out = out.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  return out.trim() + "\n";
}
