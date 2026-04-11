import {
  Sparkles,
  Mic,
  Youtube,
  Globe,
  FileText,
  AudioWaveform,
  Clock,
  BookOpen,
  Layers,
  Rss,
  GitBranch,
  Download,
} from 'lucide-react';
import ToolCard from '../components/ToolCard';
import './Home.css';

export default function Home() {
  return (
    <div className="home">
      <div className="home-inner">
        {/* Hero */}
        <div className="home-hero">
          <h1 className="home-title">What would you like to do?</h1>
          <p className="home-subtitle">
            Extract, transcribe, and understand content from any source.
          </p>
        </div>

        {/* Featured: Summarize */}
        <div className="home-featured">
          <ToolCard
            icon={Sparkles}
            title="Summarize"
            description="Summarize content from any source — text, audio, video, YouTube, web pages, and PDFs — using AI."
            href="/summarize"
            featured
          />
        </div>

        {/* Tools grid */}
        <div className="home-section">
          <h2 className="home-section-title">Individual Tools</h2>
          <div className="home-grid">
            <ToolCard
              icon={Mic}
              title="Transcribe"
              description="Upload audio or video files and get accurate transcriptions using Whisper."
              href="/transcribe"
            />
            <ToolCard
              icon={Youtube}
              title="YouTube"
              description="Paste a YouTube URL — fetches captions instantly, falls back to audio transcription."
              href="/summarize?tab=youtube"
            />
            <ToolCard
              icon={Globe}
              title="Webpage"
              description="Extract and summarize article content from any URL using Playwright."
              href="/summarize?tab=url"
            />
            <ToolCard
              icon={FileText}
              title="PDF"
              description="Upload a PDF and extract its text content for summarization."
              href="/summarize?tab=pdf"
            />
            <ToolCard
              icon={AudioWaveform}
              title="Audio Enhance"
              description="Improve audio quality — noise reduction, vocal isolation, super-resolution."
              href="/enhance"
            />
            <ToolCard
              icon={GitBranch}
              title="Audio Pipeline"
              description="Build a step-by-step enhancement chain, preview after each stage, then transcribe."
              href="/pipeline"
            />
            <ToolCard
              icon={Download}
              title="YouTube Download"
              description="Download YouTube videos or audio in your preferred format, codec, and quality."
              href="/download"
            />
            <ToolCard
              icon={Clock}
              title="History"
              description="Browse past summarization results — expand any entry to re-read or copy."
              href="/history"
            />
            <ToolCard
              icon={BookOpen}
              title="Prompts"
              description="Manage and customize the AI prompt templates used for each summarization mode."
              href="/prompts"
            />
            <ToolCard
              icon={Layers}
              title="Batch"
              description="Queue multiple audio, PDF, or image files and summarize them all at once."
              href="/batch"
            />
            <ToolCard
              icon={Rss}
              title="RSS Monitor"
              description="Subscribe to RSS or podcast feeds and auto-transcribe new episodes as they arrive."
              href="/feeds"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
