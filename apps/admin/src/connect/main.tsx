import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../styles.css'
import { ConnectPage } from './ConnectApp'
import { previewConnectLoader } from './preview'
import { loadConnectView } from './view'

const root = document.getElementById('root')
if (!root) throw new Error('Missing root element')
const loader = previewConnectLoader() ?? ((pathname: string) => loadConnectView(pathname))

createRoot(root).render(
  <StrictMode>
    <ConnectPage loader={loader} />
  </StrictMode>,
)
