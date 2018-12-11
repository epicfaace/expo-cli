import _ from 'lodash';
import { Exp } from 'xdl';

import BaseBuilder from '../BaseBuilder';
import { PLATFORMS } from '../constants';
import * as consts from './credentials/constants';
import validateProject from './projectValidator';
import * as credentials from './credentials';
import * as apple from './apple';

class IOSBuilder extends BaseBuilder {
  async run() {
    const projectMetadata = await this.fetchProjectMetadata();
    await validateProject(projectMetadata);
    await this.ensureNoInProgressBuildsExist(projectMetadata);
    await this.prepareCredentials(projectMetadata);
    const publishedExpIds = await this.ensureProjectIsPublished();
    await this.scheduleBuild(publishedExpIds, projectMetadata.bundleIdentifier);
  }

  async getAppleCtx({ bundleIdentifier, username }) {
    if (!this.appleCtx) {
      const authData = await apple.authenticate(this.options);
      this.appleCtx = { ...authData, bundleIdentifier, username };
    }
    return this.appleCtx;
  }

  async fetchProjectMetadata() {
    const { publicUrl } = this.options;

    // We fetch project's manifest here (from Expo servers or user's own server).
    const {
      args: {
        username,
        remoteFullPackageName: experienceName,
        bundleIdentifierIOS: bundleIdentifier,
        sdkVersion,
      },
    } = publicUrl
      ? await Exp.getThirdPartyInfoAsync(publicUrl)
      : await Exp.getPublishInfoAsync(this.projectDir);

    return {
      username,
      experienceName,
      sdkVersion,
      bundleIdentifier,
    };
  }

  async ensureNoInProgressBuildsExist({ sdkVersion }) {
    await this.checkStatus({ platform: PLATFORMS.IOS, sdkVersion });
  }

  async prepareCredentials(projectMetadata) {
    if (this.options.clearCredentials) {
      const credsToClear = await this.clearCredentialsIfRequested(projectMetadata);
      if (credsToClear && this.options.revokeCredentials) {
        await credentials.revoke(
          await this.getAppleCtx(projectMetadata),
          Object.keys(credsToClear)
        );
      }
    }
    const existingCredentials = await credentials.fetch(projectMetadata);
    const missingCredentials = credentials.determineMissingCredentials(existingCredentials);
    if (missingCredentials) {
      const metadata = {};
      if (
        missingCredentials.includes(consts.PROVISIONING_PROFILE) &&
        !missingCredentials.includes(consts.DISTRIBUTION_CERT)
      ) {
        // we need to get distribution certificate serial number
        metadata.distCertSerialNumber = await credentials.getDistributionCertSerialNumber(
          projectMetadata
        );
      }

      await apple.ensureAppExists(
        await this.getAppleCtx(projectMetadata),
        projectMetadata.experienceName
      );

      const {
        userCredentialsIds,
        credentials: userProvidedCredentials,
        toGenerate,
        metadata: metadataFromPrompt,
      } = await credentials.prompt(
        await this.getAppleCtx(projectMetadata),
        this.options,
        missingCredentials
      );

      Object.assign(metadata, metadataFromPrompt);

      const generatedCredentials = await credentials.generate(
        await this.getAppleCtx(projectMetadata),
        toGenerate,
        metadata
      );

      const newCredentials = {
        ...userProvidedCredentials,
        ...generatedCredentials,
      };
      await credentials.update(projectMetadata, newCredentials, userCredentialsIds);
    }
  }

  async clearCredentialsIfRequested(projectMetadata) {
    const credsToClear = this.determineCredentialsToClear();
    if (credsToClear) {
      credentials.clear(projectMetadata, credsToClear);
    }
    return credsToClear;
  }

  determineCredentialsToClear() {
    const clearAll = this.options.clearCredentials;
    const credsToClearAll = {
      distributionCert: Boolean(clearAll || this.options.clearDistCert),
      pushKey: Boolean(clearAll || this.options.clearPushKey),
      // TODO: backward compatibility, remove when all users migrate to push keys
      pushCert: Boolean(clearAll || this.options.clearPushCert),
      provisioningProfile: Boolean(clearAll || this.options.clearProvisioningProfile),
    };
    const credsToClear = _.pickBy(credsToClearAll);
    return _.isEmpty(credsToClear) ? null : credsToClear;
  }

  async ensureProjectIsPublished() {
    if (this.options.publicUrl) {
      return null;
    } else {
      return await this.ensureReleaseExists(PLATFORMS.IOS);
    }
  }

  async scheduleBuild(publishedExpIds, bundleIdentifier) {
    const { publicUrl } = this.options;
    const extraArgs = { bundleIdentifier, ...(publicUrl && { publicUrl }) };
    await this.build(publishedExpIds, PLATFORMS.IOS, extraArgs);
  }
}

export default IOSBuilder;
