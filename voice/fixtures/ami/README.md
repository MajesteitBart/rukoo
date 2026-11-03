# The AMI meeting excerpt

Voice tests speaker labels on the 60-second meeting excerpt that NVIDIA ships with NeMo-Speech.cpp. The audio is never committed: `voice/scripts/speaker-assets.ps1 -Ami` fetches the three files below from NeMo-Speech.cpp at commit `97a15afa5caa9bce5baaa86c1184103877af4101` and checks the size and SHA-256 of each against [manifest.json](manifest.json).

| File | What it is | License |
|---|---|---|
| `ami_en2002d_2132.wav` | 60 s of AMI meeting EN2002d, Mix-Headset, from 2132.5 s: unmodified 16 kHz mono 16-bit PCM | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| `ami_en2002d_2132.rttm` | Who speaks when: the reference, cut from the word-aligned `only_words` RTTM of [BUTSpeechFIT/AMI-diarization-setup](https://github.com/BUTSpeechFIT/AMI-diarization-setup), with times relative to the excerpt | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `ami_en2002d_2132.json` | The reference transcript by speaker, from the AMI manual word annotations for the same excerpt | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |

Attribution, from NeMo-Speech.cpp's `test_files/diar/README.md`: the audio and the transcript come from the [AMI Meeting Corpus](https://groups.inf.ed.ac.uk/ami/corpus/), licensed under CC BY 4.0. Three speakers take turns, with brief overlap; a fourth says only a few words. Neither Voice nor NeMo-Speech.cpp changed the files.

In the RTTM, MEE071 speaks for 20.96 s in 4 turns, FEO070 for 16.33 s in 7, MEE073 for 8.53 s in 9, and FEO072 for 0.73 s in 2.
