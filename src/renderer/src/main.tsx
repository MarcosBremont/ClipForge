import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
import { useStore } from './store'
import { useEditor } from './editorStore'
import * as E from '@shared/editor'
import { textOverlayPng, watermarkPng } from './textRender'

// Gancho para pruebas de integración (no afecta al uso normal).
;(window as unknown as { __clipforge: unknown }).__clipforge = { store: useStore, editor: useEditor, E, textOverlayPng, watermarkPng }

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
