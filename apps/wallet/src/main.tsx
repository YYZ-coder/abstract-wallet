import { createRoot } from 'react-dom/client';
import { App } from './App';
import { createBrowserServices, type RuntimeNetwork } from './browser-services';
import './style.css';

const root = createRoot(document.getElementById('root')!);
async function start() {
  const response = await fetch('/runtime-network.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('网络配置暂不可用');
  const network = await response.json() as RuntimeNetwork;
  if (network.chainId !== 421614 || !['local', 'arbitrum-sepolia'].includes(network.mode)) throw new Error('此版本只支持 Arbitrum Sepolia 测试配置');
  root.render(<><aside className="network-note"><span className="live-dot" />{network.mode === 'local' ? '本地验证环境 · 使用测试资产 · 非公开测试网' : 'Arbitrum Sepolia · 仅供测试'}<span>4337 + 7702</span></aside><App services={createBrowserServices(network)} /><footer>你的地址，你的控制权。<span>Abstract Wallet / MVP 0.1</span></footer></>);
}
start().catch(error => root.render(<main><h1>Abstract Wallet</h1><p role="alert">{error instanceof Error ? error.message : '启动失败'}</p></main>));
