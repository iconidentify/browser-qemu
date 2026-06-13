/**
 * TabBar Component
 *
 * Accessible horizontal tab navigation with ARIA attributes.
 * Supports keyboard navigation (arrow keys) and focus management.
 */

import { memo, useCallback, useRef, useEffect } from 'react';

export type TabId = 'general' | 'disks' | 'advanced';

interface Tab {
  id: TabId;
  label: string;
  hidden?: boolean;
}

interface TabBarProps {
  tabs: Tab[];
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
}

export const TabBar = memo(function TabBar({
  tabs,
  activeTab,
  onTabChange,
}: TabBarProps) {
  const tabRefs = useRef<Map<TabId, HTMLButtonElement>>(new Map());
  const visibleTabs = tabs.filter(t => !t.hidden);

  // Handle keyboard navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent, currentTab: TabId) => {
    const currentIndex = visibleTabs.findIndex(t => t.id === currentTab);
    let newIndex: number | null = null;

    switch (e.key) {
      case 'ArrowLeft':
        e.preventDefault();
        newIndex = currentIndex > 0 ? currentIndex - 1 : visibleTabs.length - 1;
        break;
      case 'ArrowRight':
        e.preventDefault();
        newIndex = currentIndex < visibleTabs.length - 1 ? currentIndex + 1 : 0;
        break;
      case 'Home':
        e.preventDefault();
        newIndex = 0;
        break;
      case 'End':
        e.preventDefault();
        newIndex = visibleTabs.length - 1;
        break;
    }

    if (newIndex !== null) {
      const newTab = visibleTabs[newIndex];
      onTabChange(newTab.id);
      tabRefs.current.get(newTab.id)?.focus();
    }
  }, [visibleTabs, onTabChange]);

  // Focus active tab when it changes
  useEffect(() => {
    // Only focus if the tab list contains focus
    const tabList = tabRefs.current.get(activeTab)?.parentElement;
    if (tabList?.contains(document.activeElement)) {
      tabRefs.current.get(activeTab)?.focus();
    }
  }, [activeTab]);

  return (
    <div className="settings-tabbar" role="tablist" aria-label="Settings sections">
      {visibleTabs.map((tab) => (
        <button
          key={tab.id}
          ref={(el) => {
            if (el) tabRefs.current.set(tab.id, el);
          }}
          role="tab"
          id={`tab-${tab.id}`}
          aria-selected={activeTab === tab.id}
          aria-controls={`panel-${tab.id}`}
          tabIndex={activeTab === tab.id ? 0 : -1}
          className={`settings-tab ${activeTab === tab.id ? 'active' : ''}`}
          onClick={() => onTabChange(tab.id)}
          onKeyDown={(e) => handleKeyDown(e, tab.id)}
          type="button"
        >
          {tab.label}
        </button>
      ))}
      <div
        className="tab-indicator"
        style={{
          '--tab-index': visibleTabs.findIndex(t => t.id === activeTab),
          '--tab-count': visibleTabs.length,
        } as React.CSSProperties}
      />
    </div>
  );
});

export default TabBar;
