/********************************************************************************
 * Copyright (C) 2018 Red Hat, Inc. and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0
 ********************************************************************************/

/* eslint-disable @typescript-eslint/no-explicit-any */

import { injectable, optional, multiInject, inject } from 'inversify';
import {
    PluginDeployerResolver, PluginDeployerFileHandler, PluginDeployerDirectoryHandler,
    PluginDeployerEntry, PluginDeployer, PluginDeployerResolverInit, PluginDeployerFileHandlerContext,
    PluginDeployerDirectoryHandlerContext, PluginDeployerEntryType, PluginDeployerHandler,
} from '../../common/plugin-protocol';
import { PluginDeployerEntryImpl } from './plugin-deployer-entry-impl';
import { PluginDeployerResolverContextImpl, PluginDeployerResolverInitImpl } from './plugin-deployer-resolver-context-impl';
import { ProxyPluginDeployerEntry } from './plugin-deployer-proxy-entry-impl';
import { PluginDeployerFileHandlerContextImpl } from './plugin-deployer-file-handler-context-impl';
import { PluginDeployerDirectoryHandlerContextImpl } from './plugin-deployer-directory-handler-context-impl';
import { ILogger, Emitter } from '@theia/core';
import { PluginCliContribution } from './plugin-cli-contribution';

@injectable()
export class PluginDeployerImpl implements PluginDeployer {

    protected readonly onDidDeployEmitter = new Emitter<void>();
    readonly onDidDeploy = this.onDidDeployEmitter.event;

    @inject(ILogger)
    protected readonly logger: ILogger;

    @inject(PluginDeployerHandler)
    protected readonly pluginDeployerHandler: PluginDeployerHandler;

    @inject(PluginCliContribution)
    protected readonly cliContribution: PluginCliContribution;

    /**
     * Inject all plugin resolvers found at runtime.
     */
    @optional() @multiInject(PluginDeployerResolver)
    private pluginResolvers: PluginDeployerResolver[];

    /**
     * Inject all file handler for local resolved plugins.
     */
    @optional() @multiInject(PluginDeployerFileHandler)
    private pluginDeployerFileHandlers: PluginDeployerFileHandler[];

    /**
     * Inject all directory handler for local resolved plugins.
     */
    @optional() @multiInject(PluginDeployerDirectoryHandler)
    private pluginDeployerDirectoryHandlers: PluginDeployerDirectoryHandler[];

    public start(): void {
        this.logger.debug('Starting the deployer with the list of resolvers', this.pluginResolvers);
        this.doStart();
    }

    public async initResolvers(): Promise<Array<void>> {

        // call init on each resolver
        const pluginDeployerResolverInit: PluginDeployerResolverInit = new PluginDeployerResolverInitImpl();
        const promises = this.pluginResolvers.map(async pluginResolver => {
            if (pluginResolver.init) {
                pluginResolver.init(pluginDeployerResolverInit);
            }
        });
        return Promise.all(promises);
    }

    protected async doStart(): Promise<void> {

        // init resolvers
        await this.initResolvers();

        // check THEIA_DEFAULT_PLUGINS or THEIA_PLUGINS env var
        const defaultPluginsValue = process.env.THEIA_DEFAULT_PLUGINS || undefined;
        const pluginsValue = process.env.THEIA_PLUGINS || undefined;
        // check the `--plugins` CLI option
        const defaultPluginsValueViaCli = this.cliContribution.localDir();

        this.logger.debug('Found the list of default plugins ID on env:', defaultPluginsValue);
        this.logger.debug('Found the list of plugins ID on env:', pluginsValue);
        this.logger.debug('Found the list of default plugins ID from CLI:', defaultPluginsValueViaCli);

        // transform it to array
        const defaultPluginIdList = defaultPluginsValue ? defaultPluginsValue.split(',') : [];
        const pluginIdList = pluginsValue ? pluginsValue.split(',') : [];
        const pluginsList = defaultPluginIdList.concat(pluginIdList).concat(defaultPluginsValueViaCli ? defaultPluginsValueViaCli.split(',') : []);

        await this.deployMultipleEntries(pluginsList);

    }

    public async deploy(pluginEntry: string): Promise<void> {
        await this.deployMultipleEntries([pluginEntry]);
    }

    protected async deployMultipleEntries(pluginEntries: ReadonlyArray<string>): Promise<void> {
        const visited = new Set<string>();
        const pluginsToDeploy = new Map<string, PluginDeployerEntry>();

        const queue = [...pluginEntries];
        while (queue.length) {
            const chunk = [];
            while (queue.length) {
                const current = queue.shift()!;
                if (visited.has(current)) {
                    continue;
                }
                visited.add(current);
                try {
                    const pluginDeployerEntries = await this.resolvePlugin(current);
                    await this.applyFileHandlers(pluginDeployerEntries);
                    await this.applyDirectoryFileHandlers(pluginDeployerEntries);
                    for (const deployerEntry of pluginDeployerEntries) {
                        const dependencies = await this.pluginDeployerHandler.getPluginDependencies(deployerEntry);
                        if (dependencies && !pluginsToDeploy.has(dependencies.metadata.model.id)) {
                            pluginsToDeploy.set(dependencies.metadata.model.id, deployerEntry);
                            if (dependencies.mapping) {
                                chunk.push(dependencies.mapping);
                            }
                        }
                    }
                } catch (e) {
                    console.error(`Failed to resolve plugins from '${current}'`, e);
                }
            }
            for (const dependencies of chunk) {
                for (const [dependency, deployableDependency] of dependencies) {
                    if (!pluginsToDeploy.has(dependency)) {
                        queue.push(deployableDependency);
                    }
                }
            }
        }

        await this.deployPlugins([...pluginsToDeploy.values()]);
    }

    /**
     * deploy all plugins that have been accepted
     */
    async deployPlugins(pluginsToDeploy: PluginDeployerEntry[]): Promise<any> {
        const acceptedPlugins = pluginsToDeploy.filter(pluginDeployerEntry => pluginDeployerEntry.isAccepted());
        const acceptedFrontendPlugins = pluginsToDeploy.filter(pluginDeployerEntry => pluginDeployerEntry.isAccepted(PluginDeployerEntryType.FRONTEND));
        const acceptedBackendPlugins = pluginsToDeploy.filter(pluginDeployerEntry => pluginDeployerEntry.isAccepted(PluginDeployerEntryType.BACKEND));

        this.logger.debug('the accepted plugins are', acceptedPlugins);
        this.logger.debug('the acceptedFrontendPlugins plugins are', acceptedFrontendPlugins);
        this.logger.debug('the acceptedBackendPlugins plugins are', acceptedBackendPlugins);

        acceptedPlugins.forEach(plugin => {
            this.logger.debug('will deploy plugin', plugin.id(), 'with changes', JSON.stringify(plugin.getChanges()), 'and this plugin has been resolved by', plugin.resolvedBy());
        });

        // local path to launch
        const pluginPaths = acceptedBackendPlugins.map(pluginEntry => pluginEntry.path());
        this.logger.debug('local path to deploy on remote instance', pluginPaths);

        await Promise.all([
            // start the backend plugins
            this.pluginDeployerHandler.deployBackendPlugins(acceptedBackendPlugins),
            this.pluginDeployerHandler.deployFrontendPlugins(acceptedFrontendPlugins)
        ]);
        this.onDidDeployEmitter.fire(undefined);
    }

    /**
     * If there are some single files, try to see if we can work on these files (like unpacking it, etc)
     */
    public async applyFileHandlers(pluginDeployerEntries: PluginDeployerEntry[]): Promise<any> {
        const waitPromises: Array<Promise<any>> = [];

        pluginDeployerEntries.filter(pluginDeployerEntry => pluginDeployerEntry.isResolved()).map(pluginDeployerEntry => {
            this.pluginDeployerFileHandlers.map(pluginFileHandler => {
                const proxyPluginDeployerEntry = new ProxyPluginDeployerEntry(pluginFileHandler, (pluginDeployerEntry) as PluginDeployerEntryImpl);
                if (pluginFileHandler.accept(proxyPluginDeployerEntry)) {
                    const pluginDeployerFileHandlerContext: PluginDeployerFileHandlerContext = new PluginDeployerFileHandlerContextImpl(proxyPluginDeployerEntry);
                    const promise: Promise<void> = pluginFileHandler.handle(pluginDeployerFileHandlerContext);
                    waitPromises.push(promise);
                }
            });

        });
        return Promise.all(waitPromises);
    }

    /**
     * Check for all registered directories to see if there are some plugins that can be accepted to be deployed.
     */
    public async applyDirectoryFileHandlers(pluginDeployerEntries: PluginDeployerEntry[]): Promise<any> {
        const waitPromises: Array<Promise<any>> = [];

        pluginDeployerEntries.filter(pluginDeployerEntry => pluginDeployerEntry.isResolved()).map(pluginDeployerEntry => {
            this.pluginDeployerDirectoryHandlers.map(pluginDirectoryHandler => {
                const proxyPluginDeployerEntry = new ProxyPluginDeployerEntry(pluginDirectoryHandler, (pluginDeployerEntry) as PluginDeployerEntryImpl);
                if (pluginDirectoryHandler.accept(proxyPluginDeployerEntry)) {
                    const pluginDeployerDirectoryHandlerContext: PluginDeployerDirectoryHandlerContext = new PluginDeployerDirectoryHandlerContextImpl(proxyPluginDeployerEntry);
                    const promise: Promise<void> = pluginDirectoryHandler.handle(pluginDeployerDirectoryHandlerContext);
                    waitPromises.push(promise);
                }
            });

        });
        return Promise.all(waitPromises);
    }

    /**
     * Check a plugin ID see if there are some resolvers that can handle it. If there is a matching resolver, then we resolve the plugin
     */
    public async resolvePlugin(pluginId: string): Promise<PluginDeployerEntry[]> {
        const pluginDeployerEntries: PluginDeployerEntry[] = [];
        const foundPluginResolver = this.pluginResolvers.find(pluginResolver => pluginResolver.accept(pluginId));
        // there is a resolver for the input
        if (foundPluginResolver) {

            // create context object
            const context = new PluginDeployerResolverContextImpl(foundPluginResolver, pluginId);

            await foundPluginResolver.resolve(context);

            context.getPlugins().forEach(entry => pluginDeployerEntries.push(entry));
        } else {
            // log it for now
            this.logger.error('No plugin resolver found for the entry', pluginId);
            pluginDeployerEntries.push(new PluginDeployerEntryImpl(pluginId, pluginId));
        }

        return pluginDeployerEntries;
    }
}
