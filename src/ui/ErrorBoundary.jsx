// Error boundary for expandable detail panels.
//
// WHY THIS EXISTS
//
// Clicking a pitcher row used to blank the entire application. Not the card —
// the whole page, down to an empty `<body>`. React unmounts the whole tree on an
// uncaught render error, and there was no boundary anywhere between a detail
// panel and the root, so a single undefined field took everything with it.
//
// The trigger was mundane: a slate restored from `localStorage` was written by
// whichever version the user last ran, and the projection shape changed across
// v20, v21 and v22. `PitcherCard` read `proj.workload.budget` and
// `p.recentLog.length` straight through. Both are now guarded and the cache key
// is versioned, but guarding each field one at a time is a losing game — the
// next shape change adds another, and the failure mode is a blank page rather
// than a visibly missing number.
//
// A detail panel is exactly the right place for a boundary: it is optional,
// user-initiated, and isolated. If one cannot render, the honest outcome is a
// short message in that row while the rest of the board keeps working.

import { Component } from 'react';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Kept on the console: this is a real defect worth seeing in devtools, it
    // just should not be fatal to the page.
    console.error('Detail panel failed to render:', error, info?.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="notice">
          <b>This detail panel could not be rendered.</b>
          <div className="sub">
            The rest of the board is unaffected. This usually means the slate was
            restored from an older cached version — hit REFRESH SLATE to rebuild
            it. {this.props.label ? `(${this.props.label})` : null}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
