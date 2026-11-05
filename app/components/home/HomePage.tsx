import {
  markAgentChatHomeHandoff,
  navigateWithAgentChatViewTransition,
} from "@agent-native/core/client/agent-chat";
import { createAgentNativeAgentKitTransport } from "@agent-native/core/client/agentkit-chat/transport";
import { useT } from "@agent-native/core/client/i18n";
import { AgentKitComposer } from "@agent-native/toolkit/app/agentkit/react/components";
import { useAgentKitControl } from "@agent-native/toolkit/app/agentkit/react/context";
import { CoreComposerRuntimeProvider } from "@agent-native/toolkit/app/chat/agentkit-chat/composer";
import { CoreAgentKitRoot } from "@agent-native/toolkit/app/chat/agentkit-chat/index";
import { useRealtimeVoiceModeOptional } from "@agent-native/toolkit/app/chat/composer";
import { WaveBackground } from "@agent-native/toolkit/app/shared";
import {
  IconFileText,
  IconGitCompare,
  IconHelpCircle,
  IconUserCheck,
} from "@tabler/icons-react";
import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";

import { Button } from "@/components/ui/button";
import { getChatHomeThreadId } from "@/lib/chat-home-thread";
import { CASES_PATH } from "@/lib/casefile-paths";
import {
  chatHandoffComposerOptions,
  chatThreadPath,
  type ChatInitialComposerOptions,
  type ChatRouteState,
} from "@/lib/chat-paths";
import { TAB_ID } from "@/lib/tab-id";

/**
 * The same AgentKit composer the chat page uses, so Connect AI and the model
 * picker look the way they will in chat. Submitting hands the prompt to the
 * full chat page instead of running it here, and voice chat continues there.
 */
function HomeAgentComposer() {
  const navigate = useNavigate();
  const realtimeVoice = useRealtimeVoiceModeOptional();
  const [threadId] = useState(getChatHomeThreadId);
  const [transport] = useState(() =>
    createAgentNativeAgentKitTransport({
      browserTabId: TAB_ID,
      surface: "app",
      adapter: { textFormat: "markdown" },
    }),
  );

  function openChat(
    message: string,
    options: ChatInitialComposerOptions,
    onLocalSubmit?: () => void,
  ) {
    const state: ChatRouteState = {
      initialMessage: message,
      initialComposerOptions: options,
    };
    markAgentChatHomeHandoff("chat");
    navigateWithAgentChatViewTransition(navigate, chatThreadPath(threadId), {
      state,
    });
    onLocalSubmit?.();
  }

  function startVoiceChat() {
    // Home shows no transcript, so the session is bound to the thread it
    // opens rather than to whichever thread is on screen when it starts.
    void realtimeVoice?.start({ threadId });
    markAgentChatHomeHandoff("chat");
    navigateWithAgentChatViewTransition(navigate, chatThreadPath(threadId));
  }

  return (
    <div
      className="agentkit-tokens w-full max-w-[calc(var(--agent-kit-conversation-max-width,47rem)-2rem)] text-start"
      data-agentkit-composer-size="large"
    >
      <CoreComposerRuntimeProvider>
        <CoreAgentKitRoot
          transport={transport}
          clientOptions={{ transportOwnership: "owned" }}
          threadId={threadId}
        >
          <HomeAgentComposerInput
            threadId={threadId}
            onSubmit={openChat}
            onVoiceChatStart={startVoiceChat}
          />
        </CoreAgentKitRoot>
      </CoreComposerRuntimeProvider>
    </div>
  );
}

function HomeAgentComposerInput({
  threadId,
  onSubmit,
  onVoiceChatStart,
}: {
  threadId: string;
  onSubmit: (
    text: string,
    options: ChatInitialComposerOptions,
    onLocalSubmit?: () => void,
  ) => void;
  onVoiceChatStart: () => void;
}) {
  const t = useT();
  const control = useAgentKitControl(threadId);

  return (
    <AgentKitComposer
      threadId={threadId}
      requireAgentEngine
      placeholder={t("chat.composerPlaceholder")}
      plusMenuMode="hidden"
      attachmentsEnabled={false}
      voiceEnabled
      onVoiceChatStart={onVoiceChatStart}
      onSubmit={async (text, files, references, options) => {
        const uploadedAttachments = files.length
          ? await control.uploadFiles(
              files.map((file) => ({
                name: file.name,
                mediaType: file.type || "application/octet-stream",
                size: file.size,
                body: file,
              })),
            )
          : [];
        onSubmit(
          text,
          chatHandoffComposerOptions(options, {
            references,
            ...(uploadedAttachments.length ? { uploadedAttachments } : {}),
          }),
          options.onLocalSubmit,
        );
      }}
    />
  );
}

/**
 * A short statement of what the product actually does, shown on the landing
 * surface. Each step is the real workflow, not a marketing claim.
 */
const HOW_IT_WORKS: Array<{ icon: ReactNode; title: string; body: string }> = [
  {
    icon: <IconFileText />,
    title: "Add the evidence",
    body: "Drop in receipts, order confirmations, bank statements, and the messages exchanged with the other side.",
  },
  {
    icon: <IconGitCompare />,
    title: "Reconstruct what happened",
    body: "CASEFILE reads each document, links them by their shared identifiers, and shows where they agree or conflict.",
  },
  {
    icon: <IconHelpCircle />,
    title: "See what is still unknown",
    body: "Missing facts and unresolved questions are shown as such, never smoothed over with a plausible guess.",
  },
  {
    icon: <IconUserCheck />,
    title: "You confirm what is established",
    body: "Analysis proposes. Nothing is recorded as a fact until a person reviews and confirms it.",
  },
];

function StepCard({
  icon,
  title,
  body,
}: {
  icon: ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="rounded-xl border border-border p-4">
      <span className="text-muted-foreground" aria-hidden="true">
        {icon}
      </span>
      <h3 className="mt-2 text-sm font-semibold">{title}</h3>
      <p className="mt-1 text-sm text-muted-foreground">{body}</p>
    </div>
  );
}

export default function HomePage() {
  const t = useT();

  return (
    <div className="flex min-h-full flex-col">
      <section className="relative isolate flex flex-col items-center gap-5 overflow-hidden px-4 pt-16 pb-10 text-center">
        <WaveBackground
          matchPageSurface
          className="pointer-events-none absolute inset-0 -z-10"
        />
        <p className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
          Casefile
        </p>
        <h1 className="max-w-2xl text-3xl font-semibold tracking-tight sm:text-4xl">
          Evidence intelligence. Human-controlled investigations.
        </h1>
        <p className="max-w-xl text-sm text-muted-foreground">
          A casefile holds the documents for one dispute. CASEFILE reconstructs what happened,
          shows what the evidence establishes, what conflicts, and what is still unknown — and
          leaves every decision to you.
        </p>
        <HomeAgentComposer />
        <Button asChild variant="outline" size="sm">
          <Link to={CASES_PATH}>Open the cases</Link>
        </Button>
      </section>

      <section className="mx-auto w-full max-w-4xl px-4 pb-16">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {HOW_IT_WORKS.map((step) => (
            <StepCard key={step.title} icon={step.icon} title={step.title} body={step.body} />
          ))}
        </div>
        <p className="mt-6 text-center text-xs text-muted-foreground">
          Built on Agent-Native. Every statement resolves to the document it came from.
        </p>
      </section>
    </div>
  );
}
