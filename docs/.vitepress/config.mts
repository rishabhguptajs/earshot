import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'earshot',
  description: 'A terminal coding agent that actually listens.',
  lang: 'en-US',
  cleanUrls: true,
  lastUpdated: true,
  base: process.env.DOCS_BASE ?? '/earshot/',
  head: [
    ['meta', { name: 'theme-color', content: '#171916' }],
    ['link', { rel: 'icon', href: `${process.env.DOCS_BASE ?? '/earshot/'}favicon.svg` }],
  ],
  themeConfig: {
    logo: '/favicon.svg',
    siteTitle: 'earshot',
    nav: [
      { text: 'Guide', link: '/getting-started' },
      { text: 'Reference', link: '/cli' },
      { text: 'Providers', link: '/providers' },
      { text: 'Roadmap', link: '/roadmap' },
    ],
    sidebar: [
      {
        text: 'Use earshot',
        items: [
          { text: 'Getting started', link: '/getting-started' },
          { text: 'CLI reference', link: '/cli' },
          { text: 'Providers', link: '/providers' },
          { text: 'Headless output', link: '/headless' },
          { text: 'Editor integration (ACP)', link: '/acp' },
        ],
      },
      {
        text: 'Extend earshot',
        items: [
          { text: 'Extensions', link: '/extending' },
          { text: 'Add a provider', link: '/adding-a-provider' },
          { text: 'Architecture', link: '/architecture' },
        ],
      },
      {
        text: 'Project',
        items: [
          { text: 'Why it listens', link: '/listening' },
          { text: 'Roadmap', link: '/roadmap' },
          { text: 'Release and QA', link: '/release' },
        ],
      },
    ],
    search: { provider: 'local' },
    socialLinks: [{ icon: 'github', link: 'https://github.com/rishabhguptajs/earshot' }],
    editLink: {
      pattern: 'https://github.com/rishabhguptajs/earshot/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },
    footer: {
      message: 'No telemetry. No subscription workarounds.',
      copyright: 'Released under the MIT License.',
    },
  },
});
