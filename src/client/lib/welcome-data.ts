// Silly terminal creatures with a consistent footprint so the empty state stays still.
export const asciiArt: string[][] = [
  [
    "        /\\_/\\       ┌──────────────┐",
    "       ( o.o )  ─────▶│ $ make magic │",
    "        > ^ <        │ brewing...   │",
    "                     └──────────────┘",
    "          daemon cat is on duty       ",
    "        (the processes look nervous)  ",
  ],
  [
    "╭────────╮ ╭────────╮ ╭────────╮",
    "│ CODEX  │ │ CLAUDE │ │   PI   │",
    "│ [o_o]  │ │ [•_•]  │ │ [^_^]  │",
    "│working │ │  idle  │ │  done  │",
    "╰───┬────╯ ╰───┬────╯ ╰───┬────╯",
    "    ╰───────────┴───────────╯     ",
    "        definitely supervised     ",
  ],
  [
    "             z  z  z              ",
    "         .-------------.           ",
    "        /  TERM DAEMON  \\          ",
    "       │     [ -_- ]     │          ",
    "       │  still running  │          ",
    "        \\_____________/           ",
    "          even while you nap        ",
  ],
  [
    "              *                     ",
    "             /\\       .             ",
    "            /__\\    *                ",
    "           ( o_o )     $ abracadabra ",
    "           /|___|\\       ┌────────┐  ",
    "            /   \\   ───▶ │ shell! │  ",
    "        terminals, but enchanted     ",
  ],
  [
    "         ╭────────┬────────╮         ",
    "         │  ^_^   │  o_o   │         ",
    "         │ codex  │ claude │         ",
    "         ├────────┴────┬───┤         ",
    "         │  >_ shell   │ π │         ",
    "         ╰─────────────┴───╯         ",
    "       terminals in their habitat    ",
  ],
  [
    "              (  (                  ",
    "               )  )                 ",
    "            .--------.               ",
    "            | coffee |]  $ uptime    ",
    "            '--------'               ",
    "          daemon fuel: adequate      ",
    "       shell count: probably enough  ",
  ],
];

// Quirky copy selected from the same local calendar-day key as the artwork.
export const dailyTexts: { title: string; body: string }[] = [
  {
    title: "Create your first terminal",
    body: "Sessions keep running in the daemon when you close the browser. They're like pet rocks — just set them and forget them.",
  },
  {
    title: "Open a terminal",
    body: "Choose a session from the sidebar. Use its split action to multitask, or drag panes around on a desktop.",
  },
  {
    title: "A new terminal awaits!",
    body: "Each terminal is a persistent shell session. Close the browser, turn off the computer — they'll still be running.",
  },
  {
    title: "Terminal paradise",
    body: "You can keep up to {maxPanes} panes open. Phones focus one at a time, while larger screens show the full layout.",
  },
  {
    title: "Yarr, matey!",
    body: "These be yer terminal ships, captain. They sail on even when ye log off. Click the + to plant a new flag.",
  },
  {
    title: "Beep boop, welcome!",
    body: "I am a very sophisticated terminal manager. I do not judge your workspace names. Or your messy directories.",
  },
  {
    title: "Level up!",
    body: "Pro tip: rename terminals to remember what they do. 'dep install' and 'npm run dev' are very different lives.",
  },
  {
    title: "Zen of terminals",
    body: "A closed tab does not kill a session. A running session does not care about your coffee. Embrace persistence.",
  },
  {
    title: "Fork indeed!",
    body: "Think of each terminal as a process fork — independent, persistent, and slightly rebellious. Clone them freely!",
  },
  {
    title: "Terminal weather",
    body: "Currently: 100% chance of productivity with scattered `sudo` commands. Grab an umbrella… or just close the browser.",
  },
  {
    title: "Neural net activated",
    body: "Enabling Pi in settings lets an AI assistant work inside your terminal. It's like having a very paid intern.",
  },
  {
    title: "Breaking news",
    body: "In a shocking turn of events, another terminal manager is 100% persistent. Locals are stunned.",
  },
];

export function localCalendarDay(date = new Date()): number {
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000);
}

export function getAsciiArt(date = new Date()): string[] {
  const index = localCalendarDay(date) % asciiArt.length;
  return asciiArt[index]!;
}

export function getDailyText(maxPanes: number, date = new Date()): { title: string; body: string } {
  const index = localCalendarDay(date) % dailyTexts.length;
  let text = dailyTexts[index]!;
  text = {
    ...text,
    body: text.body.replace("{maxPanes}", String(maxPanes)),
  };
  return text;
}
