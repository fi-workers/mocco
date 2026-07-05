import type { NextConfig } from 'next';

const config: NextConfig = {
  // @mocco/common returns with the governance domain phase.
  transpilePackages: ['@mocco/backend', '@mocco/common'],
  // React Compiler: automatic memoization — no manual useMemo/useCallback/React.memo.
  // Greenfield projects get the best ROI; our strict react-hooks lint is the prerequisite.
  reactCompiler: true,
};
export default config;
