import { Component, type ReactNode } from 'react';

/** Keeps one broken widget from blanking the whole page. */
export class ErrorBoundary extends Component<{ children: ReactNode; fallback?: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error(error);
  }

  render() {
    if (this.state.error) {
      return this.props.fallback ?? <div className="chart-empty">Не удалось отрисовать блок</div>;
    }
    return this.props.children;
  }
}
