import { createRoot } from 'react-dom/client'
import './index.css'

function App() {
  return <div id="canary" className="p-4 text-emerald-500">atrium skeleton</div>
}

createRoot(document.getElementById('root')!).render(<App />)
