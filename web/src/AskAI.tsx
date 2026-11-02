import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { CopyIcon, RefreshCcwIcon, SparklesIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { readResponse } from "./api";
import { useAuth } from "./context";
import { ErrorNotice, Loading, formatDate, useLoad } from "./ui";
import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton } from "./components/ai-elements/conversation";
import { Message, MessageAction, MessageActions, MessageContent, MessageResponse } from "./components/ai-elements/message";
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorName,
  ModelSelectorTrigger,
} from "./components/ai-elements/model-selector";
import {
  PromptInput,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  type PromptInputMessage,
} from "./components/ai-elements/prompt-input";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "./components/ai-elements/reasoning";
import { Suggestion, Suggestions } from "./components/ai-elements/suggestion";

export interface AIModel {
  id: string;
  name: string;
  description: string;
}
export interface AIQuota {
  requestsUsed: number;
  requestsLimit: number;
  tokensUsed: number;
  tokensLimit: number;
  resetsAt: number;
}
export interface AIModels {
  configured: boolean;
  models: AIModel[];
  quota: AIQuota;
}

const SUGGESTIONS = [
  "Summarize the text I paste next",
  "Draft a short project update",
  "Explain this error message",
];

export function AskAI() {
  const { auth } = useAuth();
  const load = useCallback(() => auth.api.request<AIModels>("/ai/models"), [auth]);
  const info = useLoad(load);
  if (info.loading) return <Loading>Loading Ask AI…</Loading>;
  if (!info.data) return <ErrorNotice error={info.error} />;
  return <Chat initial={info.data} />;
}

function Chat({ initial }: { initial: AIModels }) {
  const { auth } = useAuth();
  const [info, setInfo] = useState(initial);
  // Refresh the quota in place; reloading through useLoad would remount and clear the conversation.
  const refreshQuota = useCallback(() => {
    void auth.api.request<AIModels>("/ai/models").then(setInfo, () => {});
  }, [auth]);
  const [model, setModel] = useState(info.models[0]?.id ?? "");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [text, setText] = useState("");
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/ai/chat",
        // AuthStore attaches and refreshes the session token, and turns API errors into readable messages.
        fetch: async (input, init) => {
          const response = await auth.fetch(String(input), init);
          if (!response.ok) await readResponse(response);
          return response;
        },
      }),
    [auth],
  );
  const { messages, sendMessage, status, stop, error, regenerate, setMessages, clearError } = useChat({
    transport,
    onFinish: refreshQuota,
    onError: refreshQuota,
  });
  const selected = info.models.find((m) => m.id === model) ?? info.models[0];
  const busy = status === "submitted" || status === "streaming";
  const quotaLeft = Math.max(0, info.quota.requestsLimit - info.quota.requestsUsed);

  function submit(message: PromptInputMessage) {
    const value = message.text.trim();
    if (!value || busy) return;
    void sendMessage({ text: value }, { body: { model } });
    setText("");
  }

  if (!info.configured)
    return (
      <section className="empty">
        <h1>Ask AI is not available</h1>
        <p>Managed AI has not been set up on this server yet.</p>
      </section>
    );

  return (
    <div className="ask-ai">
      <div className="page-heading">
        <div>
          <h1>Ask AI</h1>
          <p>
            Chat with {selected?.name ?? "Kimi"}. {quotaLeft} of {info.quota.requestsLimit} free requests left today; resets {formatDate(info.quota.resetsAt)}.
          </p>
        </div>
        {messages.length > 0 && (
          <PromptInputButton variant="outline" onClick={() => { stop(); setMessages([]); clearError(); }}>
            New conversation
          </PromptInputButton>
        )}
      </div>
      <Conversation className="ask-ai-conversation">
        <ConversationContent>
          {messages.length === 0 ? (
            <ConversationEmptyState
              icon={<SparklesIcon className="size-8" />}
              title="Start a conversation"
              description="Answers use only what you type here. Ask AI cannot open your drives or files."
            />
          ) : (
            messages.map((message, index) => {
              const last = index === messages.length - 1;
              const answer = message.parts.filter((p) => p.type === "text").map((p) => p.text).join("\n\n");
              return (
                <div key={message.id}>
                  {message.parts.map((part, i) => {
                    if (part.type === "reasoning")
                      return (
                        <Reasoning key={i} className="w-full" isStreaming={busy && last && i === message.parts.length - 1}>
                          <ReasoningTrigger />
                          <ReasoningContent>{part.text}</ReasoningContent>
                        </Reasoning>
                      );
                    if (part.type === "text")
                      return (
                        <Message key={i} from={message.role}>
                          <MessageContent>
                            {message.role === "assistant" ? <MessageResponse>{part.text}</MessageResponse> : <p className="ask-ai-user-text">{part.text}</p>}
                          </MessageContent>
                        </Message>
                      );
                    return null;
                  })}
                  {message.role === "assistant" && last && !busy && answer && (
                    <MessageActions>
                      <MessageAction label="Retry" tooltip="Retry" onClick={() => void regenerate({ body: { model } })}>
                        <RefreshCcwIcon className="size-3" />
                      </MessageAction>
                      <MessageAction label="Copy" tooltip="Copy" onClick={() => void navigator.clipboard?.writeText(answer)}>
                        <CopyIcon className="size-3" />
                      </MessageAction>
                    </MessageActions>
                  )}
                </div>
              );
            })
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <ErrorNotice error={error} />
      {messages.length === 0 && (
        <Suggestions className="ask-ai-suggestions">
          {SUGGESTIONS.map((s) => (
            <Suggestion key={s} suggestion={s} onClick={setText} />
          ))}
        </Suggestions>
      )}
      <PromptInput onSubmit={submit} className="ask-ai-input">
        <PromptInputBody>
          <PromptInputTextarea
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            placeholder="Ask anything…"
            aria-label="Message for Ask AI"
          />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputTools>
            <ModelSelector open={pickerOpen} onOpenChange={setPickerOpen}>
              <ModelSelectorTrigger asChild>
                <PromptInputButton aria-label="Choose model">
                  <ModelSelectorName>{selected?.name}</ModelSelectorName>
                </PromptInputButton>
              </ModelSelectorTrigger>
              <ModelSelectorContent title="Choose a model">
                <ModelSelectorInput placeholder="Search models…" />
                <ModelSelectorList>
                  <ModelSelectorEmpty>No models found.</ModelSelectorEmpty>
                  <ModelSelectorGroup heading="Managed by Orbit">
                    {info.models.map((m) => (
                      <ModelSelectorItem
                        key={m.id}
                        value={m.id}
                        onSelect={() => { setModel(m.id); setPickerOpen(false); }}
                      >
                        <ModelSelectorName>
                          {m.name} <span className="muted small">{m.description}</span>
                        </ModelSelectorName>
                      </ModelSelectorItem>
                    ))}
                  </ModelSelectorGroup>
                </ModelSelectorList>
              </ModelSelectorContent>
            </ModelSelector>
          </PromptInputTools>
          <PromptInputSubmit
            status={status}
            disabled={!busy && (!text.trim() || quotaLeft === 0)}
            onClick={busy ? (e) => { e.preventDefault(); stop(); } : undefined}
            aria-label={busy ? "Stop" : "Send"}
          />
        </PromptInputFooter>
      </PromptInput>
      <p className="muted small">Answers are generated by {selected?.name ?? "Kimi"} through Orbit and may be wrong. Verify important details.</p>
    </div>
  );
}
