Collection of packages to register React components to be used in Plasmic.

# Quick links

- [Documentation][docs]
- [Slack Community][slack]

[docs]: https://www.plasmic.app/learn/
[slack]: https://www.plasmic.app/slack

# Contributing

In general, we follow the "fork-and-pull" Git workflow.

1. Fork the repo on GitHub
2. Clone the project to your own machine
3. Commit changes to your own branch
4. Push your work back up to your fork
5. Submit a Pull request so that we can review your changes

NOTE: Be sure to merge the latest from "upstream" before making a pull request!

Before starting, we recommend reading our docs for Code Components:

- [How to Register Code Components](https://docs.plasmic.app/learn/registering-code-components/)

- [Code Component API reference](https://docs.plasmic.app/learn/code-components-ref/)

## Requirements

The directory name should be the same name as the main package you'll be using to import the React components. Your package must be named `@plasmicpkgs/{package-name}` and start with version 1.0.0. It should have the most recent version of `@plasmicapp/host` as a peerDependency.

The package must work for both codegen and loader users. This means that the register functions must have a optional parameter for the loader. It should also have an optional metadata parameter for users that want to use their own custom metadata.

```typescript
export function registerFooBar(
  loader?: { registerComponent: typeof registerComponent },
  customFooBarMeta?: ComponentMeta<FooBarProps>
) {
  if (loader) {
    loader.registerComponent(FooBar, customFooBarMeta ?? FooBarMeta);
  } else {
    registerComponent(FooBar, customFooBarMeta ?? FooBarMeta);
  }
}
```

Feel free to create wrapper components if it makes the final result better for the user. You also don't need to register all the props available for the component, only the ones that will be used in the studio.

Remember to export any wrapper components/types used to register the component. Everything should be also exported from the `index.ts` file, so all the imports are from `@plasmicpkgs/{package-name}`.

We recommend a `registerAll()` function for an easy way to register all the available components in the package.

## Develop and test

To create a new plasmicpkg, the easiest approach is to clone one of the existing packages (like react-slick) and fix up the names in package.json and README. Then author your registration code in src. Please use `yarn` for package management.

To test your package before submitting your pull request, first set up a Next.js app host repo to test in using `create-plasmic-app`:

- [Setting up an app host](https://docs.plasmic.app/learn/app-hosting/)

Then install your plasmicpkg into the app host repo using a utility like `yalc`. Step by step, do the following each time you want to try out some change:

- (One-time) Install `yalc` with `yarn global add yalc`.
- From your plasmicpkg/PACKAGENAME directory, run `yalc publish`.
- From your app host directory, run `yalc add @plasmicpkgs/PACKAGENAME`.
- Restart your app host (`yarn dev`) and reload the project in Studio.

Checklist to test:

- Does your component behave well in the Studio in **both** editing and live preview modes?
- Do all of the props and slots work correctly?

Remember that your package will be used by a wide variety of users, so it's important to have easy-to-use components, with good descriptions.

After testing in the Studio, it's also good to test both the available code options: loader and codegen.

- [Codegen guide](https://docs.plasmic.app/learn/codegen-guide/)
- [Next.js loader guide](https://docs.plasmic.app/learn/nextjs-quickstart/)

---

Feel free to join our [Slack Community](slack) and ask us anything! We're here to help and always welcome contributions.
