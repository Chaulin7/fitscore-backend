# assets/

Static marketing assets served by dedicated Express routes (not the `public/`
static middleware).

## Expected files

- **`CVsprings-EU-AI-Act-checklist.pdf`** — the one-page EU AI Act checklist
  for recruitment tooling. **Not yet committed.** When present it is:
  - served at `GET /eu-ai-act-checklist.pdf` (inline, cached 1 day), linked
    from the landing page's demo section;
  - attached to the demo-request confirmation email, which also gains a
    sentence noting the attachment.

  Until the file is committed, the route returns 404, the landing link is
  broken, and confirmations go out without the attachment (a warning is
  logged at boot: `[demo] checklist PDF missing …`).
