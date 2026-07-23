import { useState } from "preact/hooks";
import { Plus, ChevronDown, ChevronUp, Sparkles } from "lucide-preact";
import { getAsciiArt, getDailyText } from "../lib/welcome-data";

interface WelcomeSectionProps {
  terminalsCount: number;
  maxPanes: number;
  creating: boolean;
  onCreate: () => void;
}

const HOW_TO_USE_STEPS = [
  { icon: "➕", text: "Click **New terminal** to create a persistent session" },
  { icon: "📂", text: "Sessions appear in the sidebar — click to open them" },
  { icon: "✂️", text: "Use a session's **split action** or drag it to build a pane layout" },
  { icon: "✏️", text: "Use the **rename action** beside a session to give it a custom name" },
  { icon: "🧠", text: "Enable Pi in settings for AI-powered terminal intelligence" },
  { icon: "🔔", text: "Choose in-app, desktop, or both completion alerts in Settings" },
];

export function WelcomeSection({
  terminalsCount,
  maxPanes,
  creating,
  onCreate,
}: WelcomeSectionProps) {
  const today = new Date();
  const asciiLines = getAsciiArt(today);
  const daily = getDailyText(maxPanes, today);
  const [showHowTo, setShowHowTo] = useState(false);

  return (
    <section class="welcome">
      <pre class="welcome-ascii">{asciiLines.join("\n")}</pre>
      <p class="eyebrow">TERMINAL WORKSPACE</p>
      <h1>{daily.title}</h1>
      <p class="welcome-body">{daily.body}</p>
      <button class="button primary" onClick={onCreate} disabled={creating}>
        <Plus size={16} /> New terminal
      </button>
      <button
        class="button how-to-button"
        onClick={() => setShowHowTo(!showHowTo)}
        aria-expanded={showHowTo}
      >
        {showHowTo ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        {showHowTo ? "Hide how to use" : "How to use"}
        <Sparkles size={14} />
      </button>
      {showHowTo && (
        <div class="how-to-panel">
          <h3>Quick start guide</h3>
          <ul>
            {HOW_TO_USE_STEPS.map((step, i) => (
              <li key={i}>
                <span class="step-icon">{step.icon}</span>
                <span
                  class="step-text"
                  dangerouslySetInnerHTML={{
                    __html: step.text.replace(
                      /\*\*(.+?)\*\*/g,
                      "<b>$1</b>",
                    ),
                  }}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
