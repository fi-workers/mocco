// The `mocco-ota` executable (the bundled bin).
import { main } from './main';

process.exitCode = await main(process.argv.slice(2));
