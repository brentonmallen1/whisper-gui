import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import Home from './pages/Home';
import Summarize from './pages/Summarize';
import Transcribe from './pages/Transcribe';
import Enhance from './pages/Enhance';
import Settings from './pages/Settings';
import Prompts from './pages/Prompts';
import History from './pages/History';
import Batch from './pages/Batch';
import Feeds from './pages/Feeds';
import Pipeline from './pages/Pipeline';
import Download from './pages/Download';
import TTS from './pages/TTS';
import { SourceCacheProvider } from './context/SourceCache';

export default function App() {
  return (
    <SourceCacheProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<Home />} />
            <Route path="/summarize" element={<Summarize />} />
            <Route path="/transcribe" element={<Transcribe />} />
            <Route path="/enhance" element={<Enhance />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/prompts" element={<Prompts />} />
            <Route path="/history" element={<History />} />
            <Route path="/batch" element={<Batch />} />
            <Route path="/feeds" element={<Feeds />} />
            <Route path="/pipeline" element={<Pipeline />} />
            <Route path="/download" element={<Download />} />
            <Route path="/tts" element={<TTS />} />
            {/* Fallback */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </SourceCacheProvider>
  );
}
