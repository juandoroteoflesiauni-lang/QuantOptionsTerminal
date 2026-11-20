import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import { initLoafTelemetry } from './perf/loafTelemetry'

initLoafTelemetry()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
