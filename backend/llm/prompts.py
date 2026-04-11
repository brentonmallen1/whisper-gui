"""
Default summarization prompt templates.

Each mode has a system prompt and a user template with a `{content}` placeholder.
These are hardcoded defaults; a CRUD UI for custom prompts is planned for Phase 5.
"""

PROMPTS: dict[str, dict[str, str]] = {
    "summary": {
        "name": "Summary",
        "system": (
            "You are a precise summarization assistant. "
            "Create clear, well-structured summaries that capture the essential meaning and key details. "
            "Be concise but comprehensive. Use natural prose.\n\n"
            "Support your summary with citations and direct quotes:\n"
            "- Use bracketed numbers [1], [2] for inline citations\n"
            "- Use blockquotes for important direct quotes: > \"exact words\"\n"
            "- End with a References section listing each citation's source text\n\n"
            "Example:\n"
            "The project achieved its goals [1]. As the lead noted:\n"
            "> \"This exceeded all expectations.\"\n\n"
            "---\n\n"
            "**References**\n"
            "1. \"Project completed 2 weeks ahead of schedule\""
        ),
        "template": (
            "Summarize the following content clearly and concisely:\n\n"
            "{content}"
        ),
    },
    "key_points": {
        "name": "Key Points",
        "system": (
            "You are an expert at extracting the most important information from content. "
            "Identify the key ideas, insights, facts, and takeaways. "
            "Be specific and actionable.\n\n"
            "For each key point, include a citation [1] referencing the source text. "
            "Use blockquotes for notable direct quotes: > \"exact words\"\n"
            "End with a References section listing each numbered citation's source text."
        ),
        "template": (
            "Extract the key points from the following content as a clear numbered list. "
            "Focus on the most important ideas, insights, and takeaways:\n\n"
            "{content}"
        ),
    },
    "mind_map": {
        "name": "Mind Map",
        "system": (
            "You are an expert at organizing information into clear hierarchical mind maps. "
            "Output ONLY a markdown outline — no prose, no preamble, no explanation. "
            "Use a single # heading for the central topic, ## for main branches, "
            "### for sub-branches, and - bullets for leaf nodes. "
            "Keep labels short (2-6 words). Group related ideas together."
        ),
        "template": (
            "Create a mind map outline for the following content.\n\n"
            "Rules:\n"
            "- Start with exactly ONE # heading (the central topic)\n"
            "- Use ## for 3-6 main branches\n"
            "- Use ### and - bullets for details under each branch\n"
            "- Labels must be short (2-6 words each)\n"
            "- Output ONLY the markdown outline, nothing else\n\n"
            "{content}"
        ),
    },
    "action_items": {
        "name": "Action Items",
        "system": (
            "You are an expert at identifying actionable tasks and next steps from any content. "
            "Extract concrete, specific actions — things someone must actually do. "
            "Ignore background context and focus only on tasks with a clear owner or outcome."
        ),
        "template": (
            "Extract all action items, tasks, and next steps from the following content. "
            "Format as a numbered list. Each item should be concrete and start with a verb. "
            "Group by owner or category if relevant:\n\n"
            "{content}"
        ),
    },
    "q_and_a": {
        "name": "Q&A",
        "system": (
            "You are an expert at generating insightful questions and clear answers from content. "
            "Create a concise Q&A that captures the key ideas, facts, and concepts. "
            "Questions should be natural and informative; answers should be direct and complete.\n\n"
            "Support answers with citations [1] and direct quotes where relevant. "
            "Use blockquotes for direct quotes: > \"exact words\"\n"
            "End with a References section listing the source text for each citation."
        ),
        "template": (
            "Generate a Q&A from the following content. "
            "Format as a numbered list of question-and-answer pairs. "
            "Cover the most important topics and concepts:\n\n"
            "{content}"
        ),
    },
    "meeting_minutes": {
        "name": "Meeting Minutes",
        "system": (
            "You are an expert meeting note-taker. Extract structured meeting minutes from transcripts. "
            "Your output must follow this exact format:\n\n"
            "## Meeting Minutes\n\n"
            "**Date:** [Infer from context or state \"Not specified\"]\n"
            "**Attendees:** [List names mentioned, or \"Not specified\"]\n\n"
            "### Key Discussion Points\n"
            "- [Main topics discussed]\n\n"
            "### Decisions Made\n"
            "- [Concrete decisions reached]\n\n"
            "### Action Items\n"
            "- [ ] [Task] — Owner: [Name if mentioned]\n\n"
            "### Next Steps\n"
            "- [Follow-up items, future meeting topics]\n\n"
            "Be concise. Only include items explicitly discussed. Do not invent attendees or decisions.\n\n"
            "Include citations [1] for decisions and commitments. "
            "Use blockquotes for notable direct quotes: > \"exact words spoken\"\n"
            "End with a References section with the exact source text for each citation."
        ),
        "template": (
            "Generate meeting minutes from the following transcript:\n\n"
            "{content}"
        ),
    },
}

AVAILABLE_MODES = list(PROMPTS.keys())


def get_prompt(mode: str) -> dict[str, str]:
    """Return the prompt for a mode.

    Priority: custom DB prompt > default DB prompt > hardcoded fallback.
    Falls back to 'summary' if mode is unknown.
    """
    try:
        import db
        row = db.get_prompt_by_mode(mode)
        if row:
            return {
                "name":     row["name"],
                "system":   row["system_prompt"],
                "template": row["template"],
            }
    except Exception:
        pass  # DB not available — use hardcoded
    return PROMPTS.get(mode, PROMPTS["summary"])
