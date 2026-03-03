import {
  DEFAULT_SFTP_TRANSFER_PROFILES,
  SftpAdaptiveTransferTuner
} from './SftpAdaptiveTransferTuner'

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(`${message}. expected=${String(expected)} actual=${String(actual)}`)
  }
}

const runCase = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
  await fn()
  console.log(`PASS ${name}`)
}

const FILE_SIZE_5MB = 5 * 1024 * 1024

const run = async (): Promise<void> => {
  await runCase('preferred profile is selected for first transfer', () => {
    const tuner = new SftpAdaptiveTransferTuner({
      profiles: DEFAULT_SFTP_TRANSFER_PROFILES,
      preferredProfileId: 'balanced-32x128k',
      explorationInterval: 8
    })

    const selected = tuner.selectProfile('demo-endpoint', 'upload')
    assertEqual(selected.id, 'balanced-32x128k', 'first selection should be preferred profile')
  })

  await runCase('periodic exploration picks untested profile', () => {
    const tuner = new SftpAdaptiveTransferTuner({
      profiles: DEFAULT_SFTP_TRANSFER_PROFILES,
      preferredProfileId: 'balanced-32x128k',
      explorationInterval: 3
    })

    const endpoint = 'demo-endpoint'
    const profile1 = tuner.selectProfile(endpoint, 'download')
    assertEqual(profile1.id, 'balanced-32x128k', 'first selection should be preferred')
    tuner.reportSuccess(endpoint, 'download', profile1.id, FILE_SIZE_5MB, 5000)

    const profile2 = tuner.selectProfile(endpoint, 'download')
    assertEqual(profile2.id, 'balanced-32x128k', 'second selection should remain preferred before exploration')
    tuner.reportSuccess(endpoint, 'download', profile2.id, FILE_SIZE_5MB, 5000)

    const profile3 = tuner.selectProfile(endpoint, 'download')
    assertEqual(profile3.id, 'compat-64x32k', 'third selection should explore next untested profile')
  })

  await runCase('higher stable throughput profile is preferred', () => {
    const tuner = new SftpAdaptiveTransferTuner({
      profiles: DEFAULT_SFTP_TRANSFER_PROFILES,
      preferredProfileId: 'balanced-32x128k',
      explorationInterval: 99
    })

    const endpoint = 'demo-endpoint'
    tuner.reportSuccess(endpoint, 'upload', 'balanced-32x128k', FILE_SIZE_5MB, 9000)
    tuner.reportSuccess(endpoint, 'upload', 'compat-64x32k', FILE_SIZE_5MB, 3000)

    const selected = tuner.selectProfile(endpoint, 'upload')
    assertEqual(selected.id, 'compat-64x32k', 'faster stable profile should be selected')
  })

  await runCase('consecutive failures penalize unstable profile', () => {
    const tuner = new SftpAdaptiveTransferTuner({
      profiles: DEFAULT_SFTP_TRANSFER_PROFILES,
      preferredProfileId: 'balanced-32x128k',
      explorationInterval: 99
    })

    const endpoint = 'demo-endpoint'
    tuner.reportSuccess(endpoint, 'download', 'balanced-32x128k', FILE_SIZE_5MB, 4500)
    tuner.reportSuccess(endpoint, 'download', 'compat-64x32k', FILE_SIZE_5MB, 2000)
    for (let index = 0; index < 5; index += 1) {
      tuner.reportFailure(endpoint, 'download', 'compat-64x32k')
    }

    const selected = tuner.selectProfile(endpoint, 'download')
    assertEqual(selected.id, 'balanced-32x128k', 'unstable profile should be downgraded by failure penalties')
  })

  await runCase('upload and download maintain independent adaptation state', () => {
    const tuner = new SftpAdaptiveTransferTuner({
      profiles: DEFAULT_SFTP_TRANSFER_PROFILES,
      preferredProfileId: 'balanced-32x128k',
      explorationInterval: 99
    })
    const endpoint = 'demo-endpoint'

    tuner.reportSuccess(endpoint, 'upload', 'compat-64x32k', FILE_SIZE_5MB, 2000)
    const uploadFirst = tuner.selectProfile(endpoint, 'upload')
    tuner.reportSuccess(endpoint, 'upload', uploadFirst.id, FILE_SIZE_5MB, 12000)
    const uploadSecond = tuner.selectProfile(endpoint, 'upload')

    tuner.reportSuccess(endpoint, 'download', 'balanced-32x128k', FILE_SIZE_5MB, 2000)
    const downloadSelected = tuner.selectProfile(endpoint, 'download')

    assertEqual(uploadSecond.id, 'compat-64x32k', 'upload direction should adapt to its own faster profile')
    assertEqual(downloadSelected.id, 'balanced-32x128k', 'download direction should keep its own best profile')
  })
}

void run().catch((error) => {
  console.error(error)
  process.exit(1)
})

