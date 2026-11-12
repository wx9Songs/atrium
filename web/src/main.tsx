import { createRoot } from 'react-dom/client'
import { App } from './App'
import { boot } from './store'
import './styles.css'

createRoot(document.getElementById('root')!).render(<App />)
boot()
