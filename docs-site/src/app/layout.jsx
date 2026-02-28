import { Footer, Layout, Navbar } from 'nextra-theme-docs';
import { Banner, Head } from 'nextra/components';
import { getPageMap } from 'nextra/page-map';
import 'nextra-theme-docs/style.css';

export const metadata = {
  title: 'Evolve SDK',
  description:
    'Run and orchestrate CLI agents in secure cloud sandboxes with built-in observability.',
};

const banner = (
  <Banner storageKey="evolve-v0.0.28">
    Evolve SDK v0.0.28 is out — storage & checkpointing, Kimi CLI + OpenCode support
  </Banner>
);

const navbar = (
  <Navbar
    logo={<b>Evolve SDK</b>}
    projectLink="https://github.com/evolving-machines-lab/evolve"
  />
);

const footer = (
  <Footer>
    Apache-2.0 {new Date().getFullYear()} © Evolving Machines.
  </Footer>
);

export default async function RootLayout({ children }) {
  return (
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <Head />
      <body>
        <Layout
          banner={banner}
          navbar={navbar}
          pageMap={await getPageMap()}
          docsRepositoryBase="https://github.com/evolving-machines-lab/evolve/tree/main/docs"
          sidebar={{ defaultMenuCollapseLevel: 9999 }}
          footer={footer}
          search={false}
        >
          {children}
        </Layout>
      </body>
    </html>
  );
}
