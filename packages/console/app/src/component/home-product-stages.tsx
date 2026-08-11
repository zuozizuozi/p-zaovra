export function DesktopWorkbenchStage() {
  return (
    <section data-component="desktop-workbench-stage" aria-label="Zaovra desktop workbench preview">
      <header data-slot="desktop-titlebar">
        <span data-slot="window-controls" aria-hidden="true">
          <span></span>
          <span></span>
          <span></span>
        </span>
        <span data-slot="window-title">zaovra / console</span>
        <span data-slot="window-state">local workspace</span>
      </header>

      <div data-slot="desktop-body">
        <aside data-slot="desktop-sidebar" aria-label="Projects and sessions">
          <div data-slot="sidebar-group">
            <span data-slot="sidebar-label">Projects</span>
            <div data-slot="sidebar-item" data-active="true">
              <span data-slot="sidebar-marker" aria-hidden="true">
                Z
              </span>
              <span>zaovra</span>
            </div>
            <div data-slot="sidebar-item">
              <span data-slot="sidebar-marker" aria-hidden="true">
                C
              </span>
              <span>console</span>
            </div>
          </div>

          <div data-slot="sidebar-group">
            <span data-slot="sidebar-label">Sessions</span>
            <div data-slot="session-item" data-active="true">
              <span data-slot="session-dot" aria-hidden="true"></span>
              <span>Homepage refresh</span>
            </div>
            <div data-slot="session-item">
              <span data-slot="session-dot" aria-hidden="true"></span>
              <span>Review provider flow</span>
            </div>
          </div>
        </aside>

        <div data-slot="desktop-main">
          <header data-slot="session-toolbar">
            <div data-slot="session-identity">
              <strong>Homepage refresh</strong>
              <span>worktree · console</span>
            </div>
            <div data-slot="session-controls" aria-label="Session context and permission mode">
              <span data-slot="control-chip">Context · files</span>
              <span data-slot="control-chip" data-tone="attention">
                Permission · ask
              </span>
            </div>
          </header>

          <div data-slot="workbench-grid">
            <section data-slot="review-pane" aria-label="File review">
              <header data-slot="pane-header">
                <span>Review</span>
                <span>index.tsx</span>
              </header>
              <div data-slot="file-path">packages/console/app/src/routes/index.tsx</div>
              <div data-slot="diff" aria-label="Code change preview">
                <div data-slot="diff-row" data-kind="context">
                  <span data-slot="line-number">132</span>
                  <code>&lt;section data-component=&quot;video&quot;&gt;</code>
                </div>
                <div data-slot="diff-row" data-kind="remove">
                  <span data-slot="line-number">133</span>
                  <code>- &lt;img src=&#123;videoPoster&#125; alt=&quot;Zaovra workspace preview&quot; /&gt;</code>
                </div>
                <div data-slot="diff-row" data-kind="add">
                  <span data-slot="line-number">133</span>
                  <code>+ &lt;DesktopWorkbenchStage /&gt;</code>
                </div>
                <div data-slot="diff-row" data-kind="add">
                  <span data-slot="line-number">134</span>
                  <code>+ &lt;ProviderStage /&gt;</code>
                </div>
              </div>
            </section>

            <section data-slot="terminal-pane" aria-label="Integrated terminal">
              <header data-slot="pane-header">
                <span>Terminal</span>
                <span>powershell</span>
              </header>
              <div data-slot="terminal-output">
                <code>
                  <span data-slot="terminal-prompt">PS console&gt;</span> bun typecheck
                </code>
                <code data-slot="terminal-muted">Checking workspace types…</code>
              </div>
            </section>
          </div>

          <footer data-slot="statusbar" aria-label="Editor services status">
            <span>
              <span data-slot="status-dot" aria-hidden="true"></span>
              LSP · TypeScript ready
            </span>
            <span>Terminal connected</span>
            <span>Review mode</span>
          </footer>
        </div>
      </div>
    </section>
  )
}

export function ProviderStage() {
  return (
    <section data-component="provider-stage" aria-label="Bring your own model provider">
      <header data-slot="provider-header">
        <div>
          <span data-slot="stage-eyebrow">Bring your own key</span>
          <h3>Connect a provider</h3>
        </div>
        <span data-slot="provider-mode">BYOK</span>
      </header>

      <p data-slot="provider-intro">
        Use credentials you manage. Provider billing and model access stay with your provider account.
      </p>

      <div data-slot="provider-list" role="list" aria-label="Supported connection types">
        <div data-slot="provider-item" role="listitem">
          <span data-slot="provider-mark" aria-hidden="true">
            A
          </span>
          <span data-slot="provider-copy">
            <strong>Anthropic</strong>
            <span>API key</span>
          </span>
          <span data-slot="provider-action">Connect</span>
        </div>
        <div data-slot="provider-item" role="listitem">
          <span data-slot="provider-mark" aria-hidden="true">
            O
          </span>
          <span data-slot="provider-copy">
            <strong>OpenAI</strong>
            <span>API key</span>
          </span>
          <span data-slot="provider-action">Connect</span>
        </div>
        <div data-slot="provider-item" role="listitem">
          <span data-slot="provider-mark" aria-hidden="true">
            G
          </span>
          <span data-slot="provider-copy">
            <strong>Google</strong>
            <span>API key</span>
          </span>
          <span data-slot="provider-action">Connect</span>
        </div>
        <div data-slot="provider-item" role="listitem">
          <span data-slot="provider-mark" aria-hidden="true">
            GH
          </span>
          <span data-slot="provider-copy">
            <strong>GitHub Copilot</strong>
            <span>Account sign-in</span>
          </span>
          <span data-slot="provider-action">Connect</span>
        </div>
        <div data-slot="provider-item" role="listitem">
          <span data-slot="provider-mark" aria-hidden="true">
            API
          </span>
          <span data-slot="provider-copy">
            <strong>Custom endpoint</strong>
            <span>OpenAI-compatible URL and key</span>
          </span>
          <span data-slot="provider-action">Configure</span>
        </div>
        <div data-slot="provider-item" role="listitem">
          <span data-slot="provider-mark" aria-hidden="true">
            LOC
          </span>
          <span data-slot="provider-copy">
            <strong>Local compatible endpoint</strong>
            <span>Connect to a local OpenAI-compatible server</span>
          </span>
          <span data-slot="provider-action">Configure</span>
        </div>
      </div>

      <div data-slot="credential-note">
        <span data-slot="note-icon" aria-hidden="true">
          key
        </span>
        <p>
          <strong>Your credentials, your provider account.</strong>
          <span>Model and workflow availability varies by provider. WorkGraph support is not implied.</span>
        </p>
      </div>

      <aside data-slot="managed-access-note" aria-label="Zaovra managed model access">
        <div>
          <strong>Zaovra managed access</strong>
          <span>Use a managed model connection without supplying a provider key.</span>
        </div>
        <span data-slot="subscription-required">Active subscription required</span>
      </aside>
    </section>
  )
}

export function WorkGraphPreviewStage() {
  return (
    <section data-component="workgraph-preview-stage" aria-label="WorkGraph preview, in development">
      <header data-slot="workgraph-header">
        <div>
          <span data-slot="stage-eyebrow">WorkGraph</span>
          <h3>Goal to verified work</h3>
        </div>
        <span data-slot="preview-badge">Preview · in development</span>
      </header>

      <div data-slot="workgraph-canvas">
        <div data-slot="graph-lines" aria-hidden="true">
          <span data-line="goal-to-plan"></span>
          <span data-line="plan-to-copy"></span>
          <span data-line="plan-to-verify"></span>
        </div>

        <article data-slot="goal-node">
          <header>
            <span data-slot="node-label">Goal</span>
            <span data-slot="node-state" data-state="active">
              In progress
            </span>
          </header>
          <strong>Make provider setup clearer and safer</strong>
          <p>Align the website flow with the desktop experience.</p>
        </article>

        <div data-slot="task-nodes" aria-label="Dependent tasks">
          <article data-slot="task-node" data-state="complete">
            <header>
              <span data-slot="node-id">Task 01</span>
              <span data-slot="node-state">Evidence</span>
            </header>
            <strong>Review provider connection states</strong>
            <p>Desktop settings and provider dialogs inspected.</p>
          </article>
          <article data-slot="task-node" data-state="active">
            <header>
              <span data-slot="node-id">Task 02</span>
              <span data-slot="node-state">Attempt</span>
            </header>
            <strong>Clarify credential ownership</strong>
            <p>Separate BYOK from managed model access.</p>
          </article>
          <article data-slot="task-node" data-state="queued">
            <header>
              <span data-slot="node-id">Task 03</span>
              <span data-slot="node-state">Queued</span>
            </header>
            <strong>Verify the finished desktop flow</strong>
            <p>Review the product surface before publishing.</p>
          </article>
        </div>
      </div>

      <div data-slot="workgraph-events" aria-label="WorkGraph execution states">
        <span data-slot="event-chip" data-state="active">
          Attempt
        </span>
        <span data-slot="event-chip" data-state="complete">
          Evidence
        </span>
        <span data-slot="event-chip">Repair</span>
        <span data-slot="event-chip">Replan</span>
        <span data-slot="event-chip">Pause/Resume</span>
      </div>

      <p data-slot="preview-note">
        WorkGraph is under active development. Preview behavior and availability may change before release.
      </p>
    </section>
  )
}
