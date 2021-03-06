import { AuthenticationError, ApolloError } from 'apollo-server-express';

import { Resolvers, TmdbMovieDetailed } from '#generated/types';

import { runIfAuthenticated, runIfAuthorized } from '#graphql/graphql.service';

import { tmdbFetch } from '#tmdb/tmdb.service';

import {
  addAccessTokenToBlacklist,
  addRefreshTokenToWhitelist,
  generateJWTToken,
  generateRefreshTokenData,
  refreshAllTokens,
  removeRefreshTokenFromWhitelist,
} from '#auth/auth.service';

import { REFRESH_TOKEN_EXPIRATION_IN_SECONDS } from '#auth/auth.config';

import usersService from '#users/users.service';

const isURIEncoded = (str: string) =>
  !str.match('.*[\\ "\\<\\>\\{\\}|\\\\^~\\[\\]].*');

const resolvers: Resolvers = {
  TMDBMovie: {
    __resolveType: (movie) => {
      return 'budget' in movie ? 'TMDBMovieDetailed' : 'TMDBMovieSimple';
    },
    id: (movie) => movie.id.toString(),
    backdropUrl: (movie, _, { imageBaseUrls }) =>
      movie.backdrop_path && imageBaseUrls
        ? imageBaseUrls.backdropBaseUrl + movie.backdrop_path
        : '',
    posterUrl: (movie, _, { imageBaseUrls }) =>
      movie.poster_path && imageBaseUrls
        ? imageBaseUrls.posterBaseUrl + movie.poster_path
        : '',
    genres: (movie, _, { genreLookupTable }) => {
      return 'genre_ids' in movie
        ? movie.genre_ids.map((genreId) =>
            genreLookupTable ? genreLookupTable[genreId] : { id: -1, name: '' },
          )
        : movie.genres;
    },
  },
  Query: {
    discover: async (
      _,
      { options: { page = 1, ...restArgs } },
      { authStatus },
    ) => {
      const queryArgsArray: string[] = [];
      Object.entries(restArgs).forEach(([key, value]) => {
        queryArgsArray.push(`&${key}=${value}`);
      });

      const { data, errors, statusCode } = await runIfAuthenticated({
        authStatus,
        operation: async () =>
          tmdbFetch(`/discover/movie?page=${page}${queryArgsArray.join('')}`),
      });

      if (errors.length) {
        if (statusCode === 401) {
          throw new AuthenticationError(errors[0].message);
        }
        throw new ApolloError(errors[0].message);
      }

      return {
        movies: data.results,
        totalPages: data.total_pages,
        totalResults: data.total_results,
      };
    },
    search: async (_, { query, page }, { authStatus }) => {
      const encodedQuery = isURIEncoded(query) ? query : encodeURI(query);

      const { data, errors, statusCode } = await runIfAuthenticated({
        authStatus,
        operation: async () =>
          tmdbFetch(`/search/movie?query=${encodedQuery}&page=${page}`),
      });

      if (errors.length) {
        if (statusCode === 401) {
          throw new AuthenticationError(errors[0].message);
        }
        throw new ApolloError(errors[0].message);
      }

      return {
        movies: data.results,
        totalPages: data.total_pages,
        totalResults: data.total_results,
      };
    },

    movie: async (_, { movieId }, { authStatus }) => {
      const { data, errors, statusCode } = await runIfAuthenticated({
        authStatus,
        operation: async () => tmdbFetch(`/movie/${movieId}`),
      });

      if (errors.length) {
        if (statusCode === 401) {
          throw new AuthenticationError(errors[0].message);
        }
        throw new ApolloError(errors[0].message);
      }

      return data;
    },

    movies: async (_, { movieIds }, { authStatus }) => {
      const movies: TmdbMovieDetailed[] = [];

      // Note that 'map' is deliberately used here to iterate instead of forEach or for...of to
      // allow for parallel execution of queries.
      // Check https://stackoverflow.com/questions/37576685/using-async-await-with-a-foreach-loop/37576787#37576787
      // for more details.

      const { errors, statusCode } = await runIfAuthenticated({
        authStatus,
        operation: async () =>
          Promise.all(
            movieIds.map(async (movieId) => {
              const response = await tmdbFetch(`/movie/${movieId}`);

              if (response.data) {
                const movie = response.data;
                movies.push(movie);
              }
            }),
          ),
      });

      if (errors.length) {
        if (statusCode === 401) {
          throw new AuthenticationError(errors[0].message);
        }
        throw new ApolloError(errors[0].message);
      }

      return {
        movies,
        totalPages: 1,
        totalResults: movies.length,
      };
    },

    users: async (_, __, { authStatus }) => {
      const { data, errors, statusCode } = await runIfAuthenticated({
        authStatus,
        operation: async () => usersService.findAllUsers(),
      });

      if (errors.length) {
        if (statusCode === 401) {
          throw new AuthenticationError(errors[0].message);
        }
        throw new ApolloError(errors[0].message);
      }

      return data;
    },
  },
  Mutation: {
    registerUser: async (_, { newUserData }) => {
      const { statusCode, data, errors } = await usersService.addUser(
        newUserData,
      );
      return { statusCode, user: data, errors };
    },

    updateUser: async (_, { userId, newUserData }, { authStatus }) => {
      const { data, errors, statusCode } = await runIfAuthorized({
        authStatus,
        targetUserId: userId,
        operation: async () => usersService.updateUser(userId, newUserData),
      });

      if (errors.length) {
        if (statusCode === 401) {
          throw new AuthenticationError(errors[0].message);
        }
        throw new ApolloError(errors[0].message);
      }

      return { statusCode, user: data, errors };
    },

    deleteUser: async (_, { userId }, { authStatus }) => {
      const { data, errors, statusCode } = await runIfAuthorized({
        authStatus,
        targetUserId: userId,
        operation: async () => usersService.deleteUser(userId),
      });

      if (errors.length) {
        if (statusCode === 401) {
          throw new AuthenticationError(errors[0].message);
        }
        throw new ApolloError(errors[0].message);
      }

      return { statusCode, user: data, errors };
    },

    addFavoriteMovieToUser: async (_, { userId, movieId }, { authStatus }) => {
      const { data, errors, statusCode } = await runIfAuthorized({
        authStatus,
        targetUserId: userId,
        operation: async () =>
          usersService.addFavoriteMovieToUser(userId, movieId),
      });

      if (errors.length) {
        if (statusCode === 401) {
          throw new AuthenticationError(errors[0].message);
        }
        throw new ApolloError(errors[0].message);
      }

      return { statusCode, user: data, errors };
    },

    removeFavoriteMovieFromUser: async (
      _,
      { userId, movieId },
      { authStatus },
    ) => {
      const { data, errors, statusCode } = await runIfAuthorized({
        authStatus,
        targetUserId: userId,
        operation: async () =>
          usersService.removeFavoriteMovieFromUser(userId, movieId),
      });

      if (errors.length) {
        if (statusCode === 401) {
          throw new AuthenticationError(errors[0].message);
        }
        throw new ApolloError(errors[0].message);
      }

      return { statusCode, user: data, errors };
    },

    loginUser: async (_, { username, password }, { res }) => {
      try {
        const {
          statusCode,
          data: user,
          errors,
        } = await usersService.loginUser({
          username,
          password,
        });
        let refreshTokenData = null;
        let jwtToken = '';

        if (user) {
          const userId = user._id.toString();
          const { passwordHash } = user;

          refreshTokenData = generateRefreshTokenData({
            userId,
            passwordHash,
          });

          jwtToken = generateJWTToken({
            userId,
            passwordHash,
          });

          if (refreshTokenData) {
            addRefreshTokenToWhitelist(refreshTokenData);
          }

          res.cookie('refreshToken', refreshTokenData.refreshToken, {
            maxAge: REFRESH_TOKEN_EXPIRATION_IN_SECONDS * 1000,
            httpOnly: true,
            secure: true,
            sameSite: 'none',
          });
        }

        return { statusCode, user, jwtToken, refreshTokenData, errors };
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : err;

        console.error(errorMessage);
        return {
          statusCode: 500,
          user: null,
          jwtToken: '',
          refreshTokenData: null,
          errors: [{ message: errorMessage as string }],
        };
      }
    },

    silentRefresh: async (_, __, { req, res }) => {
      const { refreshToken }: { refreshToken: string } = req.cookies;

      const { user, jwtToken, refreshTokenData } = await refreshAllTokens(
        refreshToken,
      );

      if (!refreshTokenData) {
        res.cookie('refreshToken', '', {
          expires: new Date(0),
          httpOnly: true,
          secure: true,
          sameSite: 'none',
        });

        return {
          statusCode: 400,
          user: null,
          jwtToken: '',
          errors: [{ message: 'Authentication Error: Invalid refresh token.' }],
        };
      }

      res.cookie('refreshToken', refreshTokenData.refreshToken, {
        maxAge: REFRESH_TOKEN_EXPIRATION_IN_SECONDS * 1000,
        httpOnly: true,
        secure: true,
        sameSite: 'none',
      });

      return {
        statusCode: 200,
        user,
        jwtToken,
        errors: [],
      };
    },

    logoutUser: async (_, __, { req, res }) => {
      const { refreshToken } = req.cookies;
      const jwtToken = req?.headers?.authorization?.slice?.(7);

      await addAccessTokenToBlacklist(jwtToken);
      await removeRefreshTokenFromWhitelist(refreshToken);

      res.cookie('refreshToken', '', {
        expires: new Date(0),
        httpOnly: true,
        secure: true,
        sameSite: 'none',
      });

      return { statusCode: 200, user: null, errors: [] };
    },
  },
};

export default resolvers;
