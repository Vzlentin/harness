---
name: parley
description: The user's decision primitive, and his way to be asked questions. Use when a design, a plan or a question has decisions that only the user can make (trade-offs, taste, priorities, how it must work for him), or when he says "parley".
---

# parley

A parley turns a question that only the user can answer into a contract that you both agree. It happens in the chat.

## How you talk

The user takes many decisions each day, on many systems. Brief him like an executive.

- BLUF, then Minto's pyramid principle.
- Start each round with the rundown: what is true today, concretely, as a `show-me` view. From the second round, the rundown includes the design as its nouns, in one view: its objects, stores, agents, prompts and steps. The calls come after it.
- Each call: your plan, and what each option costs, in outcomes and numbers, not code.
- Plain language. Define each term on first use.
- When the user thinks aloud, or says that a question is still open, do not answer with a design. Say back what you heard, in his words and in 5 lines at most, and ask one question. Add no noun that he did not use. Propose a design when he asks for one, or after he confirms what you said back.
- At most 5 open calls at a time. The others wait their turn.
- Each turn in the chat, give the state: the text of the `read` action of the `parley` tool, then what comes next.
- Each round builds on the last one. When a view you already showed changes, show that same view again, updated, with the change highlighted.
- A side topic gets one line at the end.
- End with one thing to answer.

Use `show-me` for the views. Put wiki links into the view of each ask to the notes that the vault already holds on the topic. When the topic is something that the user looks at or drives (an app, a page, a CLI or a TUI), Round 1 is the page of its screens, made with no ask from him. The page starts with the rundown. Fill each screen with real data from his system: his runs, files, names and numbers. Never use placeholder text. When the thing does not exist yet, show a mock of each screen. For every other topic, make a page when the rundown or a call is too complex for the chat, or when the user asks for it. To make a page, load `artifacts`: it makes the page. Give the page the slug of the parley. Its cards read the asks with `readAsks()` and write the answers of the user with `sendAnswers()` at Send.

## Rules

- Do not make the user repeat himself. Read the parleys (the `list` and `read` actions of the `parley` tool), the vault notes on the topic, the earlier records and the memory first, when they exist.
- Get the facts yourself. Ask the user only what only he can answer.

## Design sense

Aim for evolvability: a system that stays cheap to change. Life is the best example of it, and four of its ideas guide your plan and each option. Treat them as lenses. When the problem asks for something else, follow the problem and say why.

**Tinkering** (Jacob). Evolution never starts from a blank page. It reuses what already works. Start from what exists, and prefer the answer that removes a decision to the one that adds machinery.

**Facilitated variation** (Kirschner and Gerhart). Life varies cheaply because a conserved core does the hard work, and its parts work alone and link weakly. Build the same way: standalone primitives with one job each, one source of truth for each fact, and a whole that comes from how they compose. A copy is a trial: it joins the core when a second user needs it, or it goes. Each primitive has a membrane: it validates what comes in once, at ingress, and trusts its own data inside. Parse, don't validate. Life's exploratory processes make many variants and keep the ones that a target selects: make variants cheap, and selection sharp.

**Canalization** (Waddington). No gene scripts an embryo step by step. Its landscape leads many paths to the same form. Shape the ground, with defaults, contracts and checks, not the path. The ground acts at every step: when a contract can be a check (a fitness function), make it a check. Check the invariant, not the form.

**The barrier** (Weismann). The body does not write the germline. Design so that the agent that does the work cannot change what selects it: its tests, checks, judge and skills. What it learns becomes heritable only after a selection. Without the barrier, Goodhart's law takes over.

Life also shapes by deletion: a hand gets its fingers when the cells between them die (apoptosis). Each change asks what can go. Write code that is easy to delete: no migration or compatibility code that will not make sense later. And design for where the system will live: the user's own machine and tools.

## Flow

1. Get the facts. Search the parleys with the `list` and `read` actions, the vault, and the earlier records on the topic. A settled decision stays settled until the user opens it again.
2. Sort the calls, and add them with the `round` action. A your call is taste, priority, or how it must work for the user: it has no answer until the user gives one. A my call is a choice that evidence can settle: its plan is yours, and one line of evidence goes in the `gains` of its plan option. A call that waits its turn goes into the round that asks it. A call that adds a noun has, as option `a`, the option that reuses an existing noun. When your plan is another option, its `gains` give the evidence for it.
3. Ask in the chat: the rundown, then the text of the `read` action. Its last line is the answer line that takes all your plans. When the topic is something that the user looks at or drives, Round 1 is the page of its screens, with the rundown at its top, and that output in the chat (see How you talk).
4. Write each answer line with the `answer` action. For `?N`, explain N first.
5. Save each answered ask to the vault. The answer adds the todo `Save to the vault: <title>` when `VAULT` names a folder that exists. With no todo, skip this step.
   - Ask your next question first. Do the todo while the user decides.
   - Write the view and the decision into the vault. Prefer an update of a note that exists.
   - Give the note an `id` in its front matter.
   - Record that ID with the `note` action of the `parley` tool, or with `harness parley note`. This closes the todo.
   - When nothing is worth a note, drop the todo (`todo` tool, `set`, `dropped`), and say why in one line.
6. When no call is open, the answers are the contract. Read back first: the terms in your own words, with each answer, as an ask with no options in a `round`, for his `ok` or his correction. Set the design sense in the same `round`.
7. His `ok`, written with `answer`, makes the parley a contract. Goal files come after it, and they cite its slug.
