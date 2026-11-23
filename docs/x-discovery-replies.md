# Replies to discovered X posts

Under **Access → Approvals**, connect a user-context X token with the
`tweet.read`, `tweet.write` and `users.read` scopes. The token is encrypted
and can be replaced or disconnected there. Use an account X has approved for
AI replies. The connection verifies which account owns the token. X evaluates
write access on delivery. Replace an expired token with a current one.

Enable **X reply** in **Channel permissions**. Orbit can then queue eligible
replies automatically in Live. Turn on the **X reply** rule under **Approval
requirements** to review each reply. Shadow runs create editable proposals
that stay pending through Live activation. Recorded recipient permission is
required in both modes. Add it under **Access → Consent** using the author’s
numeric account ID prefixed with `x:` and evidence that the author invited a
response.

The agent proposes replies to the current discovery post. Orbit binds each
reply to the saved post, author and active X connection. Before delivery the
worker checks the current grant, lifecycle, global pause, consent and
budget. X self-serve replies require the author to mention the connected account
or quote one of its posts. Orbit verifies that relationship through the X API
and labels the reply as AI-generated. [X Manage Posts](https://docs.x.com/x-api/posts/manage-tweets/introduction),
[X authentication mapping](https://docs.x.com/fundamentals/authentication/guides/v2-authentication-mapping),
[X automation rules](https://help.x.com/en/rules-and-policies/x-automation).

**History → Activity** shows the delivery outcome and links to the discovery
run. Orbit retries confirmed rate-limit responses and transient lookup failures.
If the creation outcome is unknown, check the original post before taking
further action.

## Verification

**Fixture.** John’s local demo seed includes a pending reply. Run
`bun test tests/x-discovery.test.ts` against a migrated test database for the
Shadow, review, automatic, replay, retry and pause scenarios. The worker test
uses a fixture transport. The official X adapter contract is covered separately
in the unit suite.

**Hosted.** The available application bearer token returned recent search
results. X’s user lookup rejected it with HTTP 403. Live OpenRouter inference
completed against a real X discovery result and an invited fixture. A hosted
write remains unverified. To verify it, connect a user token for an X-approved
account and use a controlled post that mentions that account or quotes one of
its posts. Record the author’s consent, enable the channel grant, and require
review for the first Live send. Approve the draft and confirm one reply appears
on the post and the same provider reply ID appears in Activity.
