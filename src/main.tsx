import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

const root = document.getElementById('root')
if (!root) throw new Error('找不到應用程式掛載點 #root')
createRoot(root).render(<React.StrictMode><App /></React.StrictMode>)
