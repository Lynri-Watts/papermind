import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { LayoutGrid, BookOpen, Search, MessageCircle, Menu, X, Home as HomeIcon, FolderOpen, Settings as SettingsIcon } from 'lucide-react';
import Home from './pages/Home';
import Workspace from './pages/Workspace';
import DeepResearch from './pages/DeepResearch';
import Explore from './pages/Explore';
import SettingsPage from './pages/Settings';
import QAPanel from './components/QAPanel';
import { usePaperMindStore, initPersistence, WRITING_ENABLED } from './store';

type ViewType = 'home' | 'workspace' | 'research' | 'explore' | 'settings';

export default function App() {
  // 命名单一命名空间 'app'，键一律写相对路径（t('nav.home')）；
  // 跨命名空间必须用冒号形式（t('common:action.close')），点号会被当作键内路径。
  const { t } = useTranslation('app');
  const { currentView, setCurrentView, activeWorkspaceId, workspaces } = usePaperMindStore();
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // 启动时恢复上次工作状态（后端快照）；hydrate 内部完成工作区引导
  useEffect(() => {
    initPersistence();
  }, []);

  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId) ?? null;

  const navItems: { id: ViewType; icon: React.ReactNode; label: string; description: string; disabled?: boolean }[] = [
    {
      id: 'home',
      icon: <HomeIcon className="w-5 h-5" />,
      label: t('nav.home'),
      description: t('nav.homeDesc')
    },
    {
      id: 'workspace',
      icon: <LayoutGrid className="w-5 h-5" />,
      label: t('nav.creation'),
      // 创作模块暂时下线：入口保留但置灰，提示维护中
      description: WRITING_ENABLED ? t('nav.creationDesc') : t('nav.maintenance'),
      disabled: !WRITING_ENABLED,
    },
    {
      id: 'research',
      icon: <BookOpen className="w-5 h-5" />,
      label: t('nav.research'),
      description: t('nav.researchDesc')
    },
    {
      id: 'explore',
      icon: <Search className="w-5 h-5" />,
      label: t('nav.explore'),
      description: t('nav.exploreDesc')
    },
    {
      id: 'settings',
      icon: <SettingsIcon className="w-5 h-5" />,
      label: t('nav.settings'),
      description: t('nav.settingsDesc')
    }
  ];

  const renderView = () => {
    switch (currentView) {
      case 'home':
        return <Home />;
      case 'workspace':
        return <Workspace />;
      case 'research':
        return <DeepResearch />;
      case 'explore':
        return <Explore />;
      case 'settings':
        return <SettingsPage />;
      default:
        return <Home />;
    }
  };

  return (
    <div className="h-screen flex bg-background text-text">
      <aside
        className={`${
          sidebarOpen ? 'w-56' : 'w-16'
        } flex-shrink-0 bg-surface border-r border-border flex flex-col transition-all duration-300`}
      >
        <div className="flex items-center justify-between px-4 py-4 border-b border-border">
          {sidebarOpen && (
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-primary to-secondary flex items-center justify-center">
                <MessageCircle className="w-5 h-5 text-white" />
              </div>
              <div>
                <h1 className="font-bold text-text">PaperMind</h1>
                <p className="text-xs text-textSecondary">{t('brand.tagline')}</p>
              </div>
            </div>
          )}
          {!sidebarOpen && (
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-primary to-secondary flex items-center justify-center mx-auto">
              <MessageCircle className="w-5 h-5 text-white" />
            </div>
          )}
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="p-2 rounded-lg hover:bg-primary/20 text-textSecondary hover:text-primary transition-colors"
          >
            {sidebarOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
          </button>
        </div>

        <nav className="flex-1 py-4">
          {navItems.map((item) => (
            <button
              key={item.id}
              onClick={() => setCurrentView(item.id)}
              disabled={item.disabled}
              title={item.disabled ? t('navDisabledHint') : undefined}
              className={`w-full flex items-center gap-3 px-4 py-3 mb-1 transition-colors ${
                item.disabled
                  ? 'text-textSecondary/40 cursor-not-allowed'
                  : currentView === item.id
                    ? 'bg-primary/10 text-primary border-r-2 border-primary'
                    : 'text-textSecondary hover:text-text hover:bg-primary/5'
              }`}
            >
              {item.icon}
              {sidebarOpen && (
                <div className="text-left">
                  <p className="font-medium text-sm">{item.label}</p>
                  <p className="text-xs text-textSecondary">{item.description}</p>
                </div>
              )}
            </button>
          ))}
        </nav>

        <div className="p-4 border-t border-border">
          {sidebarOpen ? (
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-gradient-to-br from-accent/20 to-accent/5 flex items-center justify-center">
                <FolderOpen className="w-4 h-4 text-accent" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-text truncate">
                  {activeWorkspace ? activeWorkspace.name : t('workspaceSwitcher.noWorkspace')}
                </p>
                <button
                  onClick={() => setCurrentView('home')}
                  className="text-xs text-textSecondary hover:text-primary truncate"
                >
                  {activeWorkspace ? t('workspaceSwitcher.switchWorkspace') : t('workspaceSwitcher.createWorkspace')}
                </button>
              </div>
            </div>
          ) : (
            <div className="w-9 h-9 rounded-full bg-gradient-to-br from-accent/20 to-accent/5 flex items-center justify-center mx-auto">
              <FolderOpen className="w-4 h-4 text-accent" />
            </div>
          )}
        </div>
      </aside>

      <main className="flex-1 overflow-hidden">{renderView()}</main>
      {/* 全局 AI 助手：贯穿阅读 / 搜索 / 写作三大板块 */}
      <QAPanel />
    </div>
  );
}
