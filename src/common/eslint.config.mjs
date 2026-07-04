import prettier from 'eslint-config-prettier/flat';
import { createBaseConfig } from '../../eslint.config.base.mjs';

export default [...createBaseConfig({ tsconfigRootDir: import.meta.dirname }), prettier];
