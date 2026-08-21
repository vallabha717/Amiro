"use client";
import { useIsMobile } from "@/hooks/use-mobile";
import Mention from "@tiptap/extension-mention";
import { PluginKey } from "@tiptap/pm/state";
import {
  EditorContent,
  Range,
  useEditor,
  UseEditorOptions,
  Editor,
  Extension,
} from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import SuggestionPlugin, { type SuggestionKeyDownProps } from "@tiptap/suggestion";
import { TipTapMentionJsonContent } from "app-types/util";
import { cn } from "lib/utils";
import {
  FC,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  RefObject,
} from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";

export interface SkillSuggestionProps {
  top: number;
  left: number;
  width?: number;
  query: string;
  projectDirectory?: string;
  onSelect: (skill: { name: string; description?: string }) => void;
  onClose: () => void;
  bindKeyDown?: (
    handler: ((props: SuggestionKeyDownProps) => boolean) | null,
  ) => void;
  style?: React.CSSProperties;
}

interface MentionInputProps {
  disabled?: boolean;
  defaultContent?: TipTapMentionJsonContent | string;
  content?: TipTapMentionJsonContent | string;
  onChange?: (content: {
    json: TipTapMentionJsonContent;
    text: string;
    mentions: { label: string; id: string }[];
  }) => void;
  onEnter?: () => void;
  placeholder?: string;
  suggestionChar?: string;
  className?: string;
  disabledMention?: boolean;
  editorRef?: RefObject<Editor | null>;
  onFocus?: () => void;
  onBlur?: () => void;
  fullWidthSuggestion?: boolean;
  enableSkillSuggestion?: boolean;
  onSelectSkill?: (skill: { name: string; description?: string }) => void;
  projectDirectory?: string;
  MentionItem?: FC<{
    label: string;
    id: string;
  }>;
  Suggestion?: FC<{
    top: number;
    left: number;
    onClose: () => void;
    onSelectMention: (item: { label: string; id: string }) => void;
    style?: React.CSSProperties;
  }>;
  SkillSuggestion?: FC<SkillSuggestionProps>;
}

export default function MentionInput({
  defaultContent,
  content,
  onChange,
  disabled,
  onEnter,
  placeholder = "",
  suggestionChar = "@",
  MentionItem,
  disabledMention,
  Suggestion,
  SkillSuggestion,
  className,
  editorRef,
  onFocus,
  onBlur,
  fullWidthSuggestion = false,
  enableSkillSuggestion = false,
  onSelectSkill,
  projectDirectory,
}: MentionInputProps) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [skillOpen, setSkillOpen] = useState(false);
  const [skillQuery, setSkillQuery] = useState("");
  const skillKeyDownHandler = useRef<
    ((props: SuggestionKeyDownProps) => boolean) | null
  >(null);
  const [containerWidth, setContainerWidth] = useState<number | undefined>(
    undefined,
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  const position = useRef<{
    top: number;
    left: number;
    range?: Range;
  } | null>(null);

  const skillPosition = useRef<{
    top: number;
    left: number;
    range?: Range;
  } | null>(null);

  const latestContent = useRef<{
    json: TipTapMentionJsonContent;
    text: string;
  } | null>(null);

  // Memoize editor configuration
  const editorConfig = useMemo<UseEditorOptions>(() => {
    return {
      editable: !disabledRef.current,
      immediatelyRender: false,
      extensions: [
        StarterKit.configure({
          codeBlock: false,
          blockquote: false,
          code: false,
        }),
        Mention.configure({
          HTMLAttributes: {
            class: "mention",
          },
          renderHTML: (props) => {
            const el = document.createElement("div");
            el.className = "inline-flex";
            const root = createRoot(el);
            if (MentionItem)
              root.render(
                <MentionItem
                  label={props.node.attrs.label}
                  id={props.node.attrs.id}
                />,
              );
            return el;
          },
          suggestion: {
            char: suggestionChar,
            render: () => {
              return {
                onStart: (props) => {
                  if (fullWidthSuggestion) {
                    const containerRect =
                      containerRef.current?.getBoundingClientRect();
                    if (containerRect) {
                      position.current = {
                        top: containerRect.top,
                        left: containerRect.left,
                        range: props.range,
                      };
                      setContainerWidth(containerRect.width);
                      setOpen(true);
                    }
                  } else {
                    const rect = props.clientRect?.();
                    if (rect) {
                      position.current = {
                        top: rect.top,
                        left: rect.left,
                        range: props.range,
                      };
                      setContainerWidth(undefined);
                      setOpen(true);
                    }
                  }
                },
                onExit: () => setOpen(false),
              };
            },
          },
        }),
        ...(enableSkillSuggestion
          ? [
              Extension.create({
                name: "skillSuggestion",
                addProseMirrorPlugins() {
                  return [
                    SuggestionPlugin({
                      pluginKey: new PluginKey("skillSuggestion"),
                      editor: this.editor,
                      char: "/",
                      allow: ({ state, range }) => {
                        return (
                          range.from === 1 &&
                          state.doc.textContent.length === range.to - range.from
                        );
                      },
                      render: () => {
                        return {
                          onStart: (props) => {
                            if (fullWidthSuggestion) {
                              const containerRect =
                                containerRef.current?.getBoundingClientRect();
                              if (containerRect) {
                                skillPosition.current = {
                                  top: containerRect.top,
                                  left: containerRect.left,
                                  range: props.range,
                                };
                                setContainerWidth(containerRect.width);
                                setSkillQuery(props.query);
                                setSkillOpen(true);
                              }
                            } else {
                              const rect = props.clientRect?.();
                              if (rect) {
                                skillPosition.current = {
                                  top: rect.top,
                                  left: rect.left,
                                  range: props.range,
                                };
                                setSkillQuery(props.query);
                                setSkillOpen(true);
                              }
                            }
                          },
                          onUpdate: (props) => {
                            if (skillPosition.current) {
                              skillPosition.current.range = props.range;
                            }
                            setSkillQuery(props.query);
                          },
                          onExit: () => {
                            setSkillOpen(false);
                            setSkillQuery("");
                            skillPosition.current = null;
                          },
                          onKeyDown: (props) => {
                            return skillKeyDownHandler.current?.(props) ?? false;
                          },
                        };
                      },
                    }),
                  ];
                },
              }),
            ]
          : []),
      ],
      content: defaultContent ?? content,
      autofocus: true,
      onUpdate: ({ editor }) => {
        const json = editor.getJSON() as TipTapMentionJsonContent;
        const text = editor.getText();
        const mentions = json?.content
          ?.flatMap(({ content }) => {
            return content
              ?.filter((v) => v.type == "mention")
              .map(
                (v) =>
                  (
                    v as {
                      type: "mention";
                      attrs: {
                        id: string;
                        label: string;
                      };
                    }
                  ).attrs,
              );
          })
          .filter(Boolean) as { label: string; id: string }[];
        latestContent.current = {
          json,
          text,
        };
        onChange?.({
          json,
          text,
          mentions,
        });
      },
      onFocus: () => {
        onFocus?.();
      },
      onBlur: () => {
        onBlur?.();
      },
      editorProps: {
        attributes: {
          class:
            "w-full max-h-80 min-h-[2rem] break-words overflow-y-auto resize-none focus:outline-none px-2 py-1 prose prose-sm dark:prose-invert ",
        },
      },
    };
    // `disabled` is deliberately not a dependency, and is read through a ref
    // above instead. Tiptap reconfigures the editor whenever this options
    // object changes identity, and rebuilding it rebuilds the extensions array
    // with it -- so tying it to `disabled` churned the entire editor every time
    // a reply started or stopped streaming. Each churn dispatches transactions,
    // each transaction wakes every useSyncExternalStore subscriber, and in the
    // production build that hit React's nested-update cap: "Maximum update
    // depth exceeded", twice per message, exactly at the two transitions.
    // Editability changes are applied by the targeted setEditable effect below.
  }, [MentionItem, suggestionChar, onChange, enableSkillSuggestion, fullWidthSuggestion]);

  const editor = useEditor(editorConfig);

  // Expose editor through ref
  useEffect(() => {
    if (editorRef && editor) {
      editorRef.current = editor;
    }
  }, [editor]);

  // Needs `editor` in the deps: on the first pass it is still null (the config
  // sets immediatelyRender: false), so without it a mount that starts disabled
  // would stay editable.
  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [disabled, editor]);

  // Memoize handlers
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const isSubmit =
        !open &&
        !skillOpen &&
        e.key === "Enter" &&
        editor?.getText().trim().length &&
        !e.shiftKey &&
        !e.metaKey &&
        !e.nativeEvent.isComposing;
      if (isSubmit) {
        e.preventDefault();
        onEnter?.();
        if (isMobile) {
          editor?.commands.blur();
        }
      }
    },
    [editor, onEnter, open, skillOpen, isMobile],
  );

  const handleSelectSkill = useCallback(
    (skill: { name: string; description?: string }) => {
      if (skillPosition.current?.range && editor) {
        editor.chain().focus().deleteRange(skillPosition.current.range).run();
      }
      setSkillOpen(false);
      onSelectSkill?.(skill);
    },
    [editor, onSelectSkill],
  );

  // Memoize the DOM structure
  const suggestion = useMemo(() => {
    if (!open || disabledMention) return null;
    if (!Suggestion) return null;
    return createPortal(
      <Suggestion
        top={position.current?.top ?? 0}
        left={position.current?.left ?? 0}
        onClose={() => {
          setOpen(false);
        }}
        onSelectMention={(item) => {
          if (position.current?.range) {
            editor
              ?.chain()
              .focus()
              .insertContentAt(position.current.range, [
                {
                  type: "mention",
                  attrs: item,
                },
              ])
              .run();
          }
          setOpen(false);
        }}
        style={{
          width:
            fullWidthSuggestion && containerWidth
              ? `${containerWidth}px`
              : undefined,
        }}
      />,
      document.body,
    );
  }, [open, disabledMention, Suggestion, containerWidth, fullWidthSuggestion, editor]);

  const skillSuggestion = useMemo(() => {
    if (!skillOpen || disabledMention || !SkillSuggestion) return null;
    return createPortal(
      <SkillSuggestion
        top={skillPosition.current?.top ?? 0}
        left={skillPosition.current?.left ?? 0}
        width={fullWidthSuggestion && containerWidth ? containerWidth : undefined}
        query={skillQuery}
        projectDirectory={projectDirectory}
        onSelect={handleSelectSkill}
        onClose={() => setSkillOpen(false)}
        bindKeyDown={(handler) => {
          skillKeyDownHandler.current = handler;
        }}
      />,
      document.body,
    );
  }, [
    skillOpen,
    disabledMention,
    SkillSuggestion,
    fullWidthSuggestion,
    containerWidth,
    skillQuery,
    projectDirectory,
    handleSelectSkill,
  ]);

  const placeholderElement = useMemo(() => {
    if (!editor?.isEmpty) return null;

    return (
      <div className="absolute top-1 left-2 text-muted-foreground pointer-events-none">
        {placeholder}
      </div>
    );
  }, [editor?.isEmpty, placeholder]);

  useEffect(() => {
    if (open) {
      return () => {
        editor?.commands.focus();
      };
    }
    position.current = null;
    editor?.commands.focus();
  }, [open]);

  useEffect(() => {
    if (skillOpen) {
      return () => {
        editor?.commands.focus();
      };
    }
    skillPosition.current = null;
  }, [skillOpen, editor]);

  useEffect(() => {
    if (content != undefined && onChange) {
      if (
        typeof content == "string" &&
        content != latestContent.current?.text
      ) {
        editor?.commands.setContent(content);
      } else if (
        typeof content != "string" &&
        content != latestContent.current?.json
      ) {
        editor?.commands.setContent(content);
      }
    }
  }, [content]);

  const focus = useCallback(() => {
    editor?.commands.focus();
  }, [editor]);

  return (
    <div
      ref={containerRef}
      onClick={focus}
      data-testid="chat-input-container"
      className={cn("relative w-full", className)}
    >
      <EditorContent editor={editor} data-testid="chat-input" onKeyDown={handleKeyDown} />
      {suggestion}
      {skillSuggestion}
      {placeholderElement}
    </div>
  );
}
