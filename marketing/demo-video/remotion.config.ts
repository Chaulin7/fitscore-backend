import {Config} from '@remotion/cli/config';

Config.setVideoImageFormat('jpeg');
Config.setOverwriteOutput(true);
Config.setPixelFormat('yuv420p');
Config.setCodec('h264');
// No audio anywhere in this project, and no audio track should be muxed in.
Config.setMuted(true);
