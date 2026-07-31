# Build handoffs

The canonical record of every Project ManagAIr build.

One sanitised Markdown file per build branch, named for the **branch**, never for
the head SHA — naming a file after a SHA changes that SHA, which then needs
another commit to record. The exact final SHA is written by the finaliser into
its completion record and into the pull request, both of which happen after the
commit exists.

This repository is **public**. Only material classified `safe_for_public_git` is
committed here: what was built, SHAs, branch and pull request, test and build
results, migrations, user-visible behaviour, residual risks, the verdict, and
anything still outstanding. Never customer documents, transcripts, emails,
databases, provider responses containing customer data, credentials, private
Bellrock information, unredacted logs, git bundles or local machine
configuration. Those stay on the machine, classified in the handoff manifest so a
reader can see what was withheld and why.

`docs/build-finalisation.md` describes the finaliser that reads these, and
`docs/MVP-BUILD-CONTRACT.md` holds the standing order that requires them.
